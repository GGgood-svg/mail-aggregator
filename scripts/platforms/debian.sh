PLATFORM_ID=debian
PACKAGE_MANAGER=apt
SERVICE_MANAGER=systemd
platform_update() { apt-get update; }
platform_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }
