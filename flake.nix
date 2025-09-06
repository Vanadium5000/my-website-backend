{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    naersk.url = "github:nix-community/naersk";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      self,
      flake-utils,
      naersk,
      nixpkgs,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = (import nixpkgs) {
          inherit system;
        };

        naersk' = pkgs.callPackage naersk { };

        package = naersk'.buildPackage {
          src = ./.;
          # Add any build-time dependencies if needed (e.g., for Rust crates requiring them)
          nativeBuildInputs = with pkgs; [ pkg-config ];
          buildInputs = with pkgs; [ openssl ];
        };

      in
      {
        # For `nix build` & `nix run`:
        packages.default = package;

        # For `nix develop` (improved with additional Rust tools for development):
        devShell = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            rustc
            cargo
            rust-analyzer
            rustfmt
            clippy
            pkg-config
            openssl
            sqlx-cli # Added for local migration management
          ];
        };

        # Add checks for CI/testing (runs cargo test):
        checks.default = naersk'.buildPackage {
          src = ./.;
          doCheck = true;
        };
      }
    )
    // {
      # NixOS module for the service
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.my-website-backend;
        in
        {
          options.services.my-website-backend = {
            enable = lib.mkEnableOption "My website backend service";

            databaseUrl = lib.mkOption {
              type = lib.types.str;
              default = "sqlite:///var/lib/rust-backend/db.sqlite";
              description = "Database URL for the service. For SQLite, use an absolute path like 'sqlite:///var/lib/rust-backend/db.sqlite'.";
              example = "sqlite:///var/lib/rust-backend/db.sqlite";
            };

            serverKey = lib.mkOption {
              type = lib.types.str;
              description = "SERVER_KEY for JWT authentication for the service";
              example = "123456";
              default = "123456";
            };

            enableMigrations = lib.mkEnableOption "Run SQLx migrations on service startup";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
              description = "The package to use for the service.";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.rust-backend = {
              description = "Rust Backend Service";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];
              environment = {
                DATABASE_URL = cfg.databaseUrl;
                SERVER_KEY = cfg.serverKey;
              };
              serviceConfig = {
                ExecStart = "${cfg.package}/bin/my-website-backend"; # Adjust binary name if different (from Cargo.toml)
                Restart = "always";
                User = "root"; # Optional fallback; DynamicUser overrides this
                DynamicUser = true; # For better isolation
                StateDirectory = "rust-backend"; # Creates /var/lib/rust-backend owned by the user

                # Run migrations before starting if enabled
                ExecStartPre = lib.mkIf cfg.enableMigrations "${pkgs.sqlx-cli}/bin/sqlx migrate run --source ${self}/migrations";
              };
            };

            networking.firewall.allowedTCPPorts = [ 3000 ];
          };
        };
    };
}
