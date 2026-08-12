#!/system/bin/sh
MODDIR=${0%/*}
[ -x "$MODDIR/bin/configctl" ] || exit 0
"$MODDIR/bin/configctl" apply --boot >/dev/null 2>&1
exit 0

