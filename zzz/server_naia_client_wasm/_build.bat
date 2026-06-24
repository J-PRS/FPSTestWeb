@echo off
cd /d "%~dp0"
echo Building WASM client with wasm-pack...

REM Check if wasm-pack is installed
where wasm-pack >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo wasm-pack not found. Installing...
    cargo install wasm-pack
)

REM Build WASM package
wasm-pack build --target web --out-dir ../client/pkg

echo WASM build complete. Output in ../client/pkg
