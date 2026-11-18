#!/bin/sh
# /usr/lib/aib/aib-install-deb: installs a downloaded AIB update (.deb). Shipped in AIB's own .deb (root-owned, 0755) together with
# the polkit action dev.aib.app.update (/usr/share/polkit-1/actions/dev.aib.app.update.policy: "Authentication is required to
# update AIB"). AIB starts it as `pkexec /usr/lib/aib/aib-install-deb <file>` after it has checked the file against the release's
# SHA256SUMS (server/desktop/updater.ts), while it is still open; then AIB quits and its update helper starts the new version.
#
# It takes exactly one argument and refuses anything that is not AIB's own verified download:
#   - the caller is the user pkexec (PKEXEC_UID) or sudo (SUDO_UID) says, not root;
#   - the path is absolute, plain (letters, digits, . _ / + -), goes through no link, and lies in the caller's home folder;
#   - it is <...>/updates/<version>/AIB-<version>-linux-<x64|arm64>.deb, a regular file, and the file and both folders belong to the
#     caller and cannot be written by anyone else;
#   - a root-only copy of it (taken first, so the file cannot change after the checks) is a Debian package named "aib" whose Version
#     is <version> as `deno desktop` writes it (every "-" a "~").
# Only then: apt-get install -y --allow-downgrades --no-remove <the copy> (a release after its betas and test builds sorts lower for
# dpkg, hence --allow-downgrades), and the installed version is checked. dpkg undoes a failed unpack, so a failure leaves the old
# version installed.
#
# Exit codes: 0 installed; 64 bad argument or a file that is not AIB's download; 65 not an AIB package of that version; 66 not
# started as root through pkexec/sudo; 70 apt-get failed (nothing changed); 71 apt-get ran but the version is not the new one.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 077

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
home=$(getent passwd "$uid" | cut -d: -f6) || fail 66 "unknown user $uid"
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
copy=$work/$name
cp -P -- "$file" "$copy" || fail 64 "could not read the file"
[ -f "$copy" ] && [ ! -L "$copy" ] || fail 64 "not a regular file"

package=$(dpkg-deb --field "$copy" Package 2>/dev/null) || fail 65 "not a Debian package"
[ "$package" = aib ] || fail 65 "not an AIB package (Package: $package)"
debversion=$(dpkg-deb --field "$copy" Version 2>/dev/null) || fail 65 "the package has no version"
want=$(printf '%s' "$version" | tr '-' '~')
[ "$debversion" = "$want" ] || fail 65 "the package is version $debversion, not $want"

# apt reads the file as its _apt user: a root-owned copy nobody else can change, readable by all
chmod 755 "$work"
chmod 644 "$copy"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades --no-remove -o DPkg::Lock::Timeout=120 "$copy" >&2 ||
  fail 70 "apt-get could not install $want (the installed version is unchanged)"
now=$(dpkg-query -W -f='${Version}' aib 2>/dev/null) || now=''
[ "$now" = "$debversion" ] || fail 71 "apt-get finished but aib is at version ${now:-none}, not $debversion"
echo "aib-install-deb: installed aib $debversion" >&2
exit 0
