@echo off
chcp 65001

title Windows Up-to-Date 数据打包工具 v2.0

for /f %%i in ('git rev-parse --short HEAD') do set hash=%%i
for /f %%i in ('git rev-list --count HEAD') do set count=%%i
for /f %%i in ('git log -1 --format^=%%cs') do set vdate=%%i

echo {"hash":"%hash%","date":"%vdate%"}> %cd%\version.json

set filename=data-r%count%-%hash%-%date:~5,2%%date:~8,2%%date:~11,2%

"%PROGRAMFILES%\Bandizip\bz.exe" c %cd%\%filename%.zip %cd%\category\ %cd%\detail\ %cd%\viveid\ %cd%\index\ %cd%\version.json

if "%~1"=="-l" (
    goto :eof
)

echo.
node "%cd%\deploy.js"
