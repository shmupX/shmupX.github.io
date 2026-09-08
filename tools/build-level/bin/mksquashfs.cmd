@echo off
REM Stands in for the Linux mksquashfs electron-builder wants and Windows cannot
REM run — see ../lib/appimage-bridge.js. app-builder execs whatever
REM MKSQUASHFS_PATH names, and Go's exec honours PATHEXT, so a .cmd is a valid
REM target. node is already on PATH here: the tool that set MKSQUASHFS_PATH is
REM itself running under it.
node "%~dp0mksquashfs-wsl.js" %*
exit /b %errorlevel%
