#!/system/bin/sh
MODDIR=${0%/*}
if [ -f "$MODDIR/data/state/mounts.list" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] && umount "/my_product/vendor/etc/$rel" 2>/dev/null
  done < "$MODDIR/data/state/mounts.list"
fi
exit 0

