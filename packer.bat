@echo off
chcp 65001
title Windows Up-to-Date 数据打包工具 v1

for /f %%i in ('git rev-parse --short HEAD') do set hash=%%i
for /f %%i in ('git rev-list --count HEAD') do set count=%%i

set filename=data-r%count%-%hash%-%date:~5,2%%date:~8,2%%date:~11,2%

"%PROGRAMFILES%\Bandizip\bz.exe" c %cd%\%filename%.zip %cd%\category\ %cd%\detail\ %cd%\latest-builds.json