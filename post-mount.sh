#!/system/bin/sh
# APatch 在分区挂载完成后执行该脚本。configctl 的锁可避免与 post-fs-data 重复运行。
MODDIR=${0%/*}
[ -x "$MODDIR/bin/configctl" ] || exit 0
"$MODDIR/bin/configctl" apply --boot >/dev/null 2>&1
exit 0

