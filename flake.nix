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
              description = "Database URL for the service (e.g., sqlite://user:pass@host/db)";
              example = "sqlite://db.sqlite3";
              default = "sqlite://db.sqlite3";
            };

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
              };
              serviceConfig = {
                ExecStart = "${cfg.package}/bin/my-website-backend"; # Adjust binary name if different (from Cargo.toml)
                Restart = "always";
                User = "root"; # Consider creating a dedicated user for security
                DynamicUser = true; # For better isolation
              };
            };

            networking.firewall.allowedTCPPorts = [ 3000 ];
          };
        };
    };
}
