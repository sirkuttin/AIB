"""The one place AIB's version number lives. Everything that shows or sends a version imports it from here."""
__version__ = "0.1.0-beta.7"
# What people see: "AIB 0.1.0 beta" (the pre-release suffix is shown as a word).
_core, _, _pre = __version__.partition("-")
VERSION_LABEL = "AIB " + _core + (" " + _pre.split(".")[0] if _pre else "")
ABOUT_LINE = "All your agents. One place. Nothing hidden."
