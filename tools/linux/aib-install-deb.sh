#!/bin/sh
# /usr/lib/aib/aib-install-deb: installs a downloaded AIB update (.deb). Shipped in AIB's own .deb (root-owned, 0755) together with
# the polkit action dev.aib.app.update (/usr/share/polkit-1/actions/dev.aib.app.update.policy: "Authentication is required to
# update AIB"). AIB starts it as `/usr/bin/pkexec /usr/lib/aib/aib-install-deb <file>` only right after the person clicked Install
# now in AIB's window (server/desktop/updater.ts); then AIB quits and its update helper starts the new version.
#
# Root trusts nothing on the user's side for what the file is: the user's account may run other programs (agents) that can change
# the file, AIB's state or its checks at any time. So, as root, with one argument:
#   - the caller is the user pkexec (PKEXEC_UID) or sudo (SUDO_UID) says, not root;
#   - the path is absolute, plain (letters, digits, . _ / + -), goes through no link, and lies in the caller's home folder;
#   - it is <...>/updates/<version>/AIB-<version>-linux-<x64|arm64>.deb, a regular file, and the file and both folders belong to the
#     caller and cannot be written by anyone else (a mistake check: the caller could change them anyway);
#   - the file is copied, read with the caller's own permissions (never root's) and at most MAX_DEB bytes, into a root-only folder;
#     every later check reads only that copy;
#   - root fetches the release's SHA256SUMS itself over HTTPS from GitHub (RELEASES/v<version>/SHA256SUMS, certificate checked, a
#     time limit, at most MAX_SUMS bytes) and the copy's SHA-256 must be the one line for exactly this file name. No answer, no
#     line or another hash: refused. Trust is GitHub's TLS, the same as the Windows updater's;
#   - the copy is a Debian package named "aib" whose Version is <version> as `deno desktop` writes it (every "-" a "~");
#   - it is newer than the installed aib (dpkg --compare-versions), or the one case AIB orders newer and dpkg lower: the installed
#     version is <new>.test.<N> (a test build of a beta -> that beta). The same version or an older one: refused.
# Only then: apt-get install -y --no-remove <the copy> (with --allow-downgrades only for that one case), and the installed version is
# checked. dpkg undoes a failed unpack (the old version stays); a failure after the unpack (configure, a trigger) leaves the new
# files on disk, half set up: that is reported as such (exit 72), with the fix.
#
# A test machine may point the SHA256SUMS fetch elsewhere with SOURCE_FILE (root-owned, in a root-owned folder, writable by no one
# else; one line: an https:// or file:/// base). Nothing the user controls (environment, arguments, files) can.
#
# Exit codes: 0 installed; 64 bad argument or a file that is not AIB's download; 65 not an AIB package of that version; 66 not
# started as root through pkexec/sudo; 68 the release's SHA256SUMS could not be fetched; 69 the file is
# not the release's (no line for it, or another SHA-256); 70 apt-get failed and the old version is still installed; 71 apt-get ran
# but the version is not the new one; 72 apt-get failed after unpacking: partly installed (run `sudo dpkg --configure -a`);
# 73 not newer than the installed version; 74 SOURCE_FILE is not root's alone (not 67: WSL turns that exit code into its own error).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
unset APT_CONFIG DPKG_ROOT DPKG_ADMINDIR DPKG_FORCE 2>/dev/null || true
umask 077

RELEASES=https://github.com/sirkuttin/AIB/releases/download
SOURCE_FILE=/etc/aib/update-release-url
MAX_DEB=268435456 # 256 MiB; a release .deb is about 50 MB
MAX_SUMS=1048576

fail() {
  code=$1
  shift
  echo "aib-install-deb: $*" >&2
  exit "$code"
}

[ "$(id -u)" = 0 ] || fail 66 "must run as root (AIB starts it through pkexec)"
[ "$#" -eq 1 ] || fail 64 "expects exactly one argument: the downloaded .deb"
file=$1

uid=${PKEXEC_UID:-${SUDO_UID:-}}
case $uid in
  '' | *[!0-9]*) fail 66 "started without pkexec (no PKEXEC_UID)" ;;
esac
[ "$uid" != 0 ] || fail 66 "AIB updates are asked for by a user, not by root"
entry=$(getent passwd "$uid") || fail 66 "unknown user $uid"
home=$(printf '%s\n' "$entry" | cut -d: -f6)
gid=$(printf '%s\n' "$entry" | cut -d: -f4)
case $gid in
  '' | *[!0-9]*) fail 66 "user $uid has no group" ;;
esac
case $home in
  /?*) ;;
  *) fail 66 "user $uid has no home folder" ;;
esac
home=$(realpath -e -- "$home") || fail 66 "the home folder of user $uid does not exist"

case $file in
  *[!A-Za-z0-9._/+-]*) fail 64 "the path has characters an AIB download never has" ;;
esac
case $file in
  /*) ;;
  *) fail 64 "the path is not absolute" ;;
esac
case $file in
  *//* | */./* | */../* | */. | */..) fail 64 "the path is not plain" ;;
esac
real=$(realpath -e -- "$file" 2>/dev/null) || fail 64 "the file does not exist"
[ "$real" = "$file" ] || fail 64 "the path goes through a link"
case $file in
  "$home"/*) ;;
  *) fail 64 "the file is not in the home folder of the user who asked" ;;
esac

name=${file##*/}
dir=${file%/*}
version=${dir##*/}
updates=${dir%/*}
[ "${updates##*/}" = updates ] || fail 64 "the file is not in AIB's update folder"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' ||
  fail 64 "the folder is not named after a version"
case $name in
  "AIB-$version-linux-x64.deb" | "AIB-$version-linux-arm64.deb") ;;
  *) fail 64 "the file is not named as AIB's update for $version" ;;
esac
[ -f "$file" ] && [ ! -L "$file" ] || fail 64 "not a regular file"
for path in "$file" "$dir" "$updates"; do
  [ "$(stat -c %u -- "$path")" = "$uid" ] || fail 64 "$path does not belong to the user who asked"
  mode=$(stat -c %a -- "$path")
  [ $((0$mode & 022)) -eq 0 ] || fail 64 "$path can be written by others"
done

work=$(mktemp -d /tmp/aib-install-deb.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' HUP INT TERM
copy=$work/$name
# Read as the user who asked (their permissions, their limits): root never opens a path the user controls, a link swapped in after
# the checks cannot make root read a root-only file, and a fifo or a huge file cannot hold root or fill /tmp past MAX_DEB.
timeout 300 setpriv --reuid="$uid" --regid="$gid" --init-groups -- head -c $((MAX_DEB + 1)) -- "$file" >"$copy" 2>/dev/null ||
  fail 64 "could not read the file"
size=$(stat -c %s -- "$copy")
[ "$size" -gt 0 ] && [ "$size" -le "$MAX_DEB" ] || fail 64 "the file is not the size of an AIB update ($size bytes)"

# Where the release's SHA256SUMS comes from: GitHub, or a test machine's root-owned SOURCE_FILE.
base=$RELEASES
proto=https
if [ -e "$SOURCE_FILE" ] || [ -L "$SOURCE_FILE" ]; then
  [ -f "$SOURCE_FILE" ] && [ ! -L "$SOURCE_FILE" ] && [ ! -L "${SOURCE_FILE%/*}" ] || fail 74 "$SOURCE_FILE is not a plain file"
  for path in "$SOURCE_FILE" "${SOURCE_FILE%/*}"; do
    [ "$(stat -c %u -- "$path")" = 0 ] || fail 74 "$path does not belong to root"
    mode=$(stat -c %a -- "$path")
    [ $((0$mode & 022)) -eq 0 ] || fail 74 "$path can be written by others"
  done
  base=$(head -n 1 -- "$SOURCE_FILE" | tr -d '\r')
  case $base in
    *[!A-Za-z0-9._/:+-]*) fail 74 "$SOURCE_FILE has characters a release address never has" ;;
    https://?*) ;;
    file:///?*) proto=file ;;
    *) fail 74 "$SOURCE_FILE is not an https:// or file:/// address" ;;
  esac
  base=${base%/}
fi
url=$base/v$version/SHA256SUMS
sums=$work/SHA256SUMS
if [ -x /usr/bin/curl ]; then
  /usr/bin/curl --silent --show-error --fail --location --proto "=$proto" --proto-redir =https --max-redirs 5 \
    --connect-timeout 20 --max-time 90 --max-filesize "$MAX_SUMS" --output "$sums" "$url" 2>"$work/fetch.err" ||
    fail 68 "could not fetch $url ($(tail -n 1 "$work/fetch.err" 2>/dev/null)); nothing was installed"
elif [ -x /usr/bin/wget ] && [ "$proto" = https ]; then
  /usr/bin/wget --quiet --https-only --max-redirect=5 --timeout=30 --tries=2 --output-document="$sums" "$url" 2>/dev/null ||
    fail 68 "could not fetch $url; nothing was installed"
else
  fail 68 "neither curl nor wget is installed, so the release's SHA256SUMS cannot be fetched; nothing was installed"
fi
[ -f "$sums" ] && [ "$(stat -c %s -- "$sums")" -le "$MAX_SUMS" ] || fail 68 "the release's SHA256SUMS is too large"
# The one line "<64 hex> <name>" or "<64 hex> *<name>" for exactly this file name (several or none: refused, as updater.ts does).
want=$(awk -v n="$name" '
  NF == 2 { h = $1; f = $2; sub(/^\*/, "", f); sub(/\r$/, "", f)
            if (f == n && length(h) == 64 && h !~ /[^0-9A-Fa-f]/) { print tolower(h); c++ } }
  END { if (c != 1) exit 1 }' "$sums") || fail 69 "the release's SHA256SUMS has no single line for $name; nothing was installed"
have=$(sha256sum -- "$copy" | cut -d' ' -f1)
[ "$have" = "$want" ] || fail 69 "the file is not the release's $name (its SHA-256 is not the one in SHA256SUMS); nothing was installed"

package=$(dpkg-deb --field "$copy" Package 2>/dev/null) || fail 65 "not a Debian package"
[ "$package" = aib ] || fail 65 "not an AIB package (Package: $package)"
debversion=$(dpkg-deb --field "$copy" Version 2>/dev/null) || fail 65 "the package has no version"
wantversion=$(printf '%s' "$version" | tr '-' '~')
[ "$debversion" = "$wantversion" ] || fail 65 "the package is version $debversion, not $wantversion"

# Only forward: newer for dpkg, or a test build of this very version (X.test.N -> X, newer for AIB, lower for dpkg).
installed=$(dpkg-query -W -f='${Version}' aib 2>/dev/null) || installed=''
[ -n "$installed" ] || fail 73 "aib is not installed from its .deb here, so there is nothing to update"
downgrade=''
if ! dpkg --compare-versions "$debversion" gt "$installed"; then
  case $installed in
    "$debversion".test.[0-9]*)
      case ${installed#"$debversion".test.} in
        *[!0-9]*) fail 73 "aib $installed is installed; $debversion is not newer" ;;
      esac
      downgrade=--allow-downgrades
      ;;
    *) fail 73 "aib $installed is installed; $debversion is not newer, so it is not installed" ;;
  esac
fi

# apt reads the file as its _apt user: a root-owned copy nobody else can change, readable by all
chmod 755 "$work"
chmod 644 "$copy"
if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -q $downgrade --no-remove -o DPkg::Lock::Timeout=120 "$copy" >&2; then
  now=$(dpkg-query -W -f='${Version} ${db:Status-Abbrev}' aib 2>/dev/null) || now=''
  case $now in
    "$installed ii"*) fail 70 "apt-get could not install $debversion; aib $installed is still installed, unchanged" ;;
    *) fail 72 "apt-get failed after unpacking $debversion: aib is now '${now:-unknown}', partly installed (fix: sudo dpkg --configure -a)" ;;
  esac
fi
now=$(dpkg-query -W -f='${Version}' aib 2>/dev/null) || now=''
[ "$now" = "$debversion" ] || fail 71 "apt-get finished but aib is at version ${now:-none}, not $debversion"
echo "aib-install-deb: installed aib $debversion" >&2
exit 0
