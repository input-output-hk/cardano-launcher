{ pkgs ? import ./nix/nivpkgs.nix {} }:

with pkgs;

mkShell {
  buildInputs = [
    # javascript
    nodejs nodePackages.npm
    # documentation tools
    pandoc mscgen librsvg gnumake
    # util to update nixpkgs pins
    niv.niv
    # cardano jormungandr
    cardanoWalletPackages.cardano-wallet-jormungandr
    cardanoWalletPackages.jormungandr
    # cardano byron
    cardanoWalletPackages.cardano-wallet-byron
    cardano-node
  ];

  BYRON_CONFIGS = cardano-node.configs;
}
