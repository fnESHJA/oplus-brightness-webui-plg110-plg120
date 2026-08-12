#!/system/bin/sh
MODDIR=${0%/*}

echo "OPlus 亮度控制 WebUI - PLG110/120 显示适配"
echo "配置: $MODDIR/config/config.json"
echo "原厂: $MODDIR/data/original/etc"
echo ""

if "$MODDIR/bin/configctl" apply; then
  echo ""
  echo "配置已生成并逐文件挂载。"
  echo "显示服务通常会缓存 XML，请重启设备以可靠生效。"
  echo "可在 data/state/status.json 查看详细状态。"
else
  code=$?
  echo ""
  echo "应用失败（错误码 $code）。原配置和挂载已保留。"
  echo "日志: $MODDIR/data/logs/apply.log"
  exit "$code"
fi
