{
  description = "Vertek Engine - browser-based WebGPU 3D engine and real-time scene editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        nodejs = pkgs.nodejs_22;

        # `nix run` - start the Vite dev server from the current checkout.
        # Installs node_modules on first run (or when package-lock.json changes).
        dev = pkgs.writeShellApplication {
          name = "vertek-dev";
          runtimeInputs = [ nodejs ];
          text = ''
            if [ ! -f package.json ] || ! grep -q '"name": "vertek-engine"' package.json; then
              echo "vertek-dev: run this from the vertek-engine project root" >&2
              exit 1
            fi
            if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
              npm install
            fi
            exec npm run dev -- "$@"
          '';
        };

        # Reproducible production build (static files in $out/share/vertek-engine).
        vertek-engine = pkgs.buildNpmPackage {
          pname = "vertek-engine";
          version = "0.1.0";
          inherit nodejs;
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./package-lock.json
              ./tsconfig.json
              ./vite.config.ts
              ./index.html
              ./src
              ./public
            ];
          };
          # Update after changing dependencies:
          #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-j8a6NOKr+HARrnVSIjlC+/NX1Sd/60j/x7kGa2KseCQ=";
          npmBuildScript = "build";
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/vertek-engine
            cp -r dist/. $out/share/vertek-engine/
            runHook postInstall
          '';
          meta = {
            description = "WebGPU 3D engine with dynamic lights, glTF/OBJ loading and a real-time editor";
            platforms = lib.platforms.all;
          };
        };

        # `nix run .#serve` - serve the production build on http://localhost:8080
        # (localhost counts as a secure context, which WebGPU requires).
        serve = pkgs.writeShellApplication {
          name = "vertek-serve";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            port="''${1:-8080}"
            echo "Serving Vertek Engine on http://localhost:$port"
            exec python3 -m http.server "$port" --bind 127.0.0.1 --directory ${vertek-engine}/share/vertek-engine
          '';
        };
      in
      {
        packages = {
          default = vertek-engine;
          inherit vertek-engine;
        };

        apps = {
          default = {
            type = "app";
            program = lib.getExe dev;
            meta.description = "Run the Vertek Engine Vite dev server";
          };
          dev = self.apps.${system}.default;
          serve = {
            type = "app";
            program = lib.getExe serve;
            meta.description = "Serve the production build of Vertek Engine";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.typescript-language-server
            pkgs.prefetch-npm-deps
          ];
          shellHook = ''
            echo "Vertek Engine dev shell - node $(node --version), npm $(npm --version)"
            echo "  npm install    install dependencies"
            echo "  npm run dev    start the dev server (http://localhost:5173)"
            echo "  npm run build  type-check and build to dist/"
          '';
        };

        # `nix develop .#tests` - adds what the optional GPU smoke tests need:
        # the Vulkan loader for Dawn (node `webgpu` package) and Chromium.
        devShells.tests = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.chromium
          ];
          LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.vulkan-loader ];
          VERTEK_CHROMIUM = lib.getExe pkgs.chromium;
          shellHook = ''
            echo "Vertek Engine test shell - run: (cd tests && npm install && npm test)"
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
