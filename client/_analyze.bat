@echo off
cd /d "%~dp0"
if not exist reports\analysis mkdir reports\analysis
echo Running knip...
node node_modules\knip\bin\knip.js --production --strict > reports\analysis\knip.txt 2>&1
type reports\analysis\knip.txt
echo.
echo Running tsc...
npx tsc --noEmit > reports\analysis\tsc.txt 2>&1
type reports\analysis\tsc.txt
echo.
echo Running jscpd...
npx jscpd src > reports\analysis\jscpd.txt 2>&1
type reports\analysis\jscpd.txt
echo.
echo Running oxlint...
node node_modules\oxlint\bin\oxlint src > reports\analysis\oxlint.txt 2>&1
type reports\analysis\oxlint.txt
echo.
echo Analysis complete.