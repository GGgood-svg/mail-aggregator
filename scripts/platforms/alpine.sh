PLATFORM_ID=alpine
PACKAGE_MANAGER=apk
SERVICE_MANAGER=openrc
platform_update() { apk update; }
platform_install() { apk add --no-cache "$@"; }
