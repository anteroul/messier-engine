{
  description = "Messier Engine - browser-based WebGPU 3D engine and real-time scene editor";

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
          name = "messier-dev";
          runtimeInputs = [ nodejs ];
          text = ''
            if [ ! -f package.json ] || ! grep -q '"name": "messier-engine"' package.json; then
              echo "messier-dev: run this from the messier-engine project root" >&2
              exit 1
            fi
            if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
              npm install
            fi
            exec npm run dev -- "$@"
          '';
        };

        # Reproducible production build (static files in $out/share/messier-engine).
        messier-engine = pkgs.buildNpmPackage {
          pname = "messier-engine";
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
          npmDepsHash = "sha256-t8Y8DVftGg2ScVg7KpGklfjqbBcy2yRDE8BcKezcHZU=";
          npmBuildScript = "build";
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/messier-engine
            cp -r dist/. $out/share/messier-engine/
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
          name = "messier-serve";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            port="''${1:-8080}"
            echo "Serving Messier Engine on http://localhost:$port"
            exec python3 -m http.server "$port" --bind 127.0.0.1 --directory ${messier-engine}/share/messier-engine
          '';
        };
      in
      {
        packages = {
          default = messier-engine;
          inherit messier-engine;
        };

        apps = {
          default = {
            type = "app";
            program = lib.getExe dev;
            meta.description = "Run the Messier Engine Vite dev server";
          };
          dev = self.apps.${system}.default;
          serve = {
            type = "app";
            program = lib.getExe serve;
            meta.description = "Serve the production build of Messier Engine";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.typescript-language-server
            pkgs.prefetch-npm-deps
          ];
          shellHook = ''
            echo "Messier Engine dev shell - node $(node --version), npm $(npm --version)"
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
          MESSIER_CHROMIUM = lib.getExe pkgs.chromium;
          shellHook = ''
            echo "Messier Engine test shell - run: (cd tests && npm install && npm test)"
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
