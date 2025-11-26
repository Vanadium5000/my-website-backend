{
  description = "My Website Backend - Nix Flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        backendPackage = pkgs.stdenv.mkDerivation {
          pname = "my-website-backend";
          version = "1.0.50";

          src = ./.;

          nativeBuildInputs = [ pkgs.unzip ];

          installPhase = ''
            mkdir -p $out/
            mkdir -p $out/bin/
            cp -r . $out/
            unzip my-website-backend.zip

            # bun build --compile --no-compile-autoload-dotenv --minify ./src/index.ts --outfile my-website-backend
            cp ./my-website-backend $out/bin/my-website-backend
            chmod +x $out/bin/my-website-backend
          '';

          meta = with pkgs.lib; {
            description = "My Website Backend";
            license = licenses.mit;
            mainProgram = "my-website-backend";
          };
        };
      in
      {
        packages.default = backendPackage;

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs
            typescript
            # Add other dev tools as needed, e.g., typescript-language-server for IDE support
          ];
          shellHook = ''
            echo "Development environment for my-website-backend"
            echo "Run 'bun run dev' to start development server"
          '';
        };
      }
    )
    // {
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        with lib;
        let
          cfg = config.services.my-website-backend;
        in
        {
          options.services.my-website-backend = {
            enable = mkEnableOption "My Website Backend service";
            package = mkOption {
              type = types.package;
              default = self.packages.${pkgs.system}.default;
              defaultText = literalExpression "self.packages.\${pkgs.system}.default";
              description = "The backend package to use";
            };
            envFile = mkOption {
              type = types.path;
              description = "Path to environment file containing required variables";
            };
            port = mkOption {
              type = types.port;
              default = 3000;
              description = "Port for the backend to listen on";
            };
            corsOrigins = mkOption {
              type = types.listOf types.str;
              default = [
                "http://localhost:5173"
                "https://my-website.space"
              ];
              description = "Allowed CORS origins";
            };
            user = mkOption {
              type = types.str;
              default = "my-website-backend";
              description = "User to run the service as";
            };
            group = mkOption {
              type = types.str;
              default = "my-website-backend";
              description = "Group to run the service as";
            };
            dataDir = mkOption {
              type = types.str;
              default = "/var/lib/my-website-backend";
              description = "Directory to store persistent data like images";
            };
          };

          config = mkIf cfg.enable {
            users.users.${cfg.user} = {
              isSystemUser = true;
              group = cfg.group;
              description = "My Website Backend user";
            };
            users.groups.${cfg.group} = { };

            systemd.tmpfiles.rules = [
              "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} - -"
            ];

            systemd.services.my-website-backend = {
              description = "My Website Backend";
              after = [ "network.target" ];
              wantedBy = [ "multi-user.target" ];
              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Group = cfg.group;
                WorkingDirectory = cfg.package;
                ExecStart = "${cfg.package}/bin/my-website-backend run .";
                EnvironmentFile = cfg.envFile;
                Restart = "always";
                RestartSec = 5;
              };
              environment = {
                PORT = toString cfg.port;
                CORS_ORIGINS = concatStringsSep "," cfg.corsOrigins;
                NODE_ENV = "production";
                DATA_DIR = cfg.dataDir;
              };
            };
          };
        };
    };
}
