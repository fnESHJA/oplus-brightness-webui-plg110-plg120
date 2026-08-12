#!/system/bin/sh
MODDIR=${0%/*}
[ -x "$MODDIR/bin/configctl" ] || exit 0
"$MODDIR/bin/configctl" verify-mounts >/dev/null 2>&1
"$MODDIR/bin/configctl" update-description >/dev/null 2>&1
exit 0

