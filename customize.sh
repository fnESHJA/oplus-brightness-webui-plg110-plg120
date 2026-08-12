#!/system/bin/sh

SKIPMOUNT=true
PROPFILE=false
POSTFSDATA=true
LATESTARTSERVICE=true

TARGET_ETC=/my_product/vendor/etc

ui_print "***************************************"
ui_print "  OPlus Brightness Control WebUI - PLG110/120 1.0.0"
ui_print "***************************************"
ui_print "- 检测 Root 管理器与设备结构"

# Failed module updates are normally removed from modules_update immediately.
# Persist a self-contained diagnostic report outside MODPATH before aborting so
# it remains readable from a file manager after KernelSU/Magisk/APatch exits.
save_install_failure() {
  failure_code="$1"
  failure_reason="$2"
  failure_dir=
  stamp="$(date '+%Y%m%d-%H%M%S' 2>/dev/null)"
  [ -n "$stamp" ] || stamp="$(date +%s 2>/dev/null)"
  [ -n "$stamp" ] || stamp=unknown

  for candidate in \
    /storage/emulated/0/Download/OPlusBrightness \
    /sdcard/Download/OPlusBrightness \
    /data/media/0/Download/OPlusBrightness \
    /data/local/tmp/OPlusBrightness; do
    probe="$candidate/.write-test.$$"
    if mkdir -p "$candidate" 2>/dev/null && printf '%s\n' test > "$probe" 2>/dev/null; then
      rm -f "$probe" 2>/dev/null
      failure_dir="$candidate"
      break
    fi
    rm -f "$probe" 2>/dev/null
  done

  [ -n "$failure_dir" ] || return 1
  failure_log="$failure_dir/install-failed-$stamp.log"
  {
    echo 'OPlus Brightness Control WebUI - PLG110/120 installation failure'
    echo 'module_version=1.0.0'
    echo "timestamp=$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)"
    echo "error_code=$failure_code"
    echo "reason=$failure_reason"
    echo "temporary_module_path=$MODPATH"
    echo "target_etc=$TARGET_ETC"
    echo "target_exists=$([ -d "$TARGET_ETC" ] && echo true || echo false)"
    echo "abi=$(getprop ro.product.cpu.abi 2>/dev/null)"
    echo "sdk=$(getprop ro.build.version.sdk 2>/dev/null)"
    echo "fingerprint=$(getprop ro.build.fingerprint 2>/dev/null)"
    echo "kernel=$(uname -a 2>/dev/null)"
    echo "ksu=${KSU:-unknown}"
    echo "ksu_version=${KSU_VER_CODE:-unknown}"
    echo "magisk_version=${MAGISK_VER_CODE:-unknown}"
    echo "apatch_version=${APATCH_VER_CODE:-unknown}"
    echo "brightness_file=${BRIGHTNESS_FILE:-not_detected}"
    echo "apollo_file=${APOLLO_FILE:-not_detected}"
    echo "sensor_file=${SENSOR_FILE:-not_detected}"
    echo "dbvgain_file=${DBVGAIN_FILE:-not_detected}"
    echo "panel_demura_file=${PANEL_DEMURA_FILE:-not_detected}"
    echo "mapping_relationship=${MAPPING_RELATIONSHIP:-not_detected}"
    echo "mapping_relationship_stats=${MAPPING_STATS:-not_detected}"
    echo
    echo '--- target XML candidates ---'
    find "$TARGET_ETC" -maxdepth 1 -type f \( -name 'display_*.xml' -o -name 'multimedia_display_*.xml' -o -name '*_sensor_lock.xml' \) -print 2>/dev/null | sort
    echo
    echo '--- target mountinfo ---'
    awk -v p="$TARGET_ETC" '$5==p || index($5,p"/")==1 {print}' /proc/self/mountinfo 2>/dev/null
    echo
    echo '--- enabled module names ---'
    for module_dir in /data/adb/modules/*; do
      [ -d "$module_dir" ] || continue
      [ -f "$module_dir/disable" ] || echo "$(basename "$module_dir")"
    done
    for source_log in install.log apply.log; do
      echo
      echo "--- data/logs/$source_log ---"
      [ -f "$MODPATH/data/logs/$source_log" ] && cat "$MODPATH/data/logs/$source_log" || echo '(not available)'
    done
    echo
    echo '--- generated mapping relationship config ---'
    grep -E '^  "mapping_relationship(_stats)?":' "$MODPATH/config/config.json" 2>/dev/null || echo '(not available)'
    echo
    echo '--- module runtime inventory ---'
    ls -ld "$MODPATH" "$MODPATH/config" "$MODPATH/data" "$MODPATH/data/state" "$MODPATH/data/original/etc" 2>&1
    ls -l "$MODPATH/config" "$MODPATH/data/state" 2>&1
    echo
    echo '--- key file sizes ---'
    wc -c "$MODPATH/bin/configctl" "$MODPATH/config/config.json" "$MODPATH/config/defaults.json" \
      "$MODPATH/data/state/mapping_relationship" "$MODPATH/data/state/managed_files.list" 2>&1
    echo
    echo '--- runtime command paths ---'
    for runtime_command in sh awk sed grep find cp mv sha256sum; do
      command -v "$runtime_command" 2>/dev/null || echo "$runtime_command=not_found"
    done
    echo
    echo '--- data/state/status.json ---'
    [ -f "$MODPATH/data/state/status.json" ] && cat "$MODPATH/data/state/status.json" || echo '(not available)'
  } > "$failure_log" 2>&1 || return 1

  cp -af "$failure_log" "$failure_dir/install-failed-latest.log" 2>/dev/null
  chmod 0644 "$failure_log" "$failure_dir/install-failed-latest.log" 2>/dev/null
  sync 2>/dev/null
  LAST_FAILURE_LOG="$failure_log"
  return 0
}

fail_install() {
  failure_code="$1"
  shift
  failure_reason="$*"
  LAST_FAILURE_LOG=
  save_install_failure "$failure_code" "$failure_reason"
  if [ -n "$LAST_FAILURE_LOG" ]; then
    ui_print "! Diagnostic log saved:"
    ui_print "  $LAST_FAILURE_LOG"
    ui_print "  Latest: $(dirname "$LAST_FAILURE_LOG")/install-failed-latest.log"
  else
    ui_print "! Could not write diagnostic log to shared storage"
  fi
  abort "! $failure_code: $failure_reason"
}

ABI="$(getprop ro.product.cpu.abi 2>/dev/null)"
case "$ABI" in
  arm64-v8a|arm64*) ;;
  *) fail_install E_UNSUPPORTED_ABI "ARM64 required; current ABI: ${ABI:-unknown}" ;;
esac

[ -d "$TARGET_ETC" ] || fail_install E_TARGET_MISSING "Missing target directory: $TARGET_ETC"

set -- "$TARGET_ETC"/display_brightness_config_*.xml
[ "$#" -eq 1 ] && [ -f "$1" ] || fail_install E_BRIGHTNESS_FILE_COUNT "Expected exactly one display_brightness_config_*.xml"
BRIGHTNESS_FILE="$(basename "$1")"

set -- "$TARGET_ETC"/display_apollo_list_*.xml
[ "$#" -eq 1 ] && [ -f "$1" ] || fail_install E_APOLLO_FILE_COUNT "Expected exactly one display_apollo_list_*.xml"
APOLLO_FILE="$(basename "$1")"

for f in display_brightness_app_list.xml multimedia_display_brightness_config.xml \
  multimedia_display_uir_config.xml multimedia_display_voltage_limit.xml; do
  [ -f "$TARGET_ETC/$f" ] || fail_install E_REQUIRED_FILE_MISSING "Missing required file: $f"
done

set -- "$TARGET_ETC"/*_sensor_lock.xml
[ "$#" -eq 1 ] && [ -f "$1" ] || fail_install E_SENSOR_FILE_COUNT "Expected exactly one *_sensor_lock.xml"
SENSOR_FILE="$(basename "$1")"

set -- "$TARGET_ETC"/display_dbvgain_config_panel_*.xml
[ "$#" -eq 1 ] && [ -f "$1" ] || fail_install E_DBVGAIN_FILE_COUNT "Expected exactly one display_dbvgain_config_panel_*.xml"
DBVGAIN_FILE="$(basename "$1")"

set -- "$TARGET_ETC"/display_demura_config_panel_*.xml
[ "$#" -eq 1 ] && [ -f "$1" ] || fail_install E_DEMURA_FILE_COUNT "Expected exactly one display_demura_config_panel_*.xml"
PANEL_DEMURA_FILE="$(basename "$1")"

grep -q '<brightness_table ' "$TARGET_ETC/$BRIGHTNESS_FILE" || fail_install E_BRIGHTNESS_SCHEMA "brightness_table node is incompatible"
grep -q '<Levels apollo=' "$TARGET_ETC/$APOLLO_FILE" || fail_install E_APOLLO_SCHEMA "Apollo Levels node is incompatible"
grep -q '<method id="4">' "$TARGET_ETC/display_brightness_app_list.xml" || fail_install E_APP_POLICY_SCHEMA "method id=4 is missing"
grep -q '<game_edr>' "$TARGET_ETC/display_brightness_app_list.xml" || fail_install E_GAME_EDR_SCHEMA "game_edr node is missing"
grep -q '<lux_table name="expressiveness">' "$TARGET_ETC/multimedia_display_brightness_config.xml" || fail_install E_AUTO_CURVE_SCHEMA "expressiveness lux_table is missing"
grep -q '<Hbm_Lux>' "$TARGET_ETC/$SENSOR_FILE" || fail_install E_HBM_SCHEMA "Hbm_Lux node is missing"

# Read the relationship from the device files. A linked pair must have the
# same logical Level set and the same nit at every Level. DBV is Apollo-only;
# several logical levels may intentionally share one DBV and are counted here
# so the editor can keep that physical grade coherent.
MAPPING_STATS=$(awk -F',' '
  BEGIN { nit_mismatch=0; unique_dbv=0; shared_groups=0; max_group=0 }
  function trim(s){gsub(/^[[:space:]]+|[[:space:]]+$/,"",s);return s}
  function abs(v){return v<0?-v:v}
  NR==FNR && /<level>/ {
    s=$0;sub(/^.*<level>/,"",s);sub(/<\/level>.*$/,"",s)
    n=split(s,a,",");if(n<4){bad="brightness row has fewer than 4 columns";next}
    id=trim(a[1]);idx=trim(a[2]);nit=trim(a[3])
    if(id!~/^[0-9]+$/ || idx!~/^[0-9]+$/ || nit!~/^[0-9]+([.][0-9]+)?$/){bad="invalid brightness row";next}
    if(id in bseen){bad="duplicate brightness Level " id;next}
    bseen[id]=1;bnit[id]=nit+0;brows++;if(id+0!=idx+0)index_mismatch++
    next
  }
  NR!=FNR && /<Level>/ {
    s=$0;sub(/^.*<Level>/,"",s);sub(/<\/Level>.*$/,"",s)
    n=split(s,a,",");if(n<4){bad="Apollo row has fewer than 4 columns";next}
    id=trim(a[1]);dbv1=trim(a[2]);dbv2=trim(a[3]);nit=trim(a[n])
    if(id!~/^[0-9]+$/ || dbv1!~/^[0-9]+$/ || dbv2!~/^[0-9]+$/ || nit!~/^[0-9]+([.][0-9]+)?$/){bad="invalid Apollo row";next}
    if(id in aseen){bad="duplicate Apollo Level " id;next}
    if(!(id in bseen)){bad="Apollo Level missing from brightness table: " id;next}
    if(dbv1+0!=dbv2+0){bad="Apollo DBV columns differ at Level " id;next}
    aseen[id]=1;arows++;dbv_count[dbv1+0]++
    if(abs((bnit[id]+0)-(nit+0))>0.0005)nit_mismatch++
    next
  }
  END {
    for(id in bseen)if(!(id in aseen)){bad="brightness Level missing from Apollo: " id;break}
    if(brows!=arows)bad="row count differs: brightness=" brows ", Apollo=" arows
    if(brows<2)bad="mapping contains fewer than two rows"
    if(index_mismatch)bad="brightness logical Level/index mismatch count=" index_mismatch
    if(bad!=""){print bad > "/dev/stderr";exit 20}
    for(dbv in dbv_count){unique_dbv++;if(dbv_count[dbv]>1){shared_groups++;if(dbv_count[dbv]>max_group)max_group=dbv_count[dbv]}}
    relationship=(nit_mismatch==0?"linked_equal":"separate_nit")
    print relationship "|" brows "|" nit_mismatch "|" unique_dbv "|" shared_groups "|" max_group
  }
' "$TARGET_ETC/$BRIGHTNESS_FILE" "$TARGET_ETC/$APOLLO_FILE")
mapping_rc=$?
[ "$mapping_rc" -eq 0 ] && [ -n "$MAPPING_STATS" ] || fail_install E_MAPPING_RELATIONSHIP "Brightness/Apollo logical structure is incompatible; see diagnostic output"
printf '%s\n' "$MAPPING_STATS" | awk -F'|' 'NF==6&&($1=="linked_equal"||$1=="separate_nit"){for(i=2;i<=6;i++)if($i!~/^[0-9]+$/)exit 1;exit 0}{exit 1}' || \
  fail_install E_MAPPING_STATS "Invalid relationship statistics: $MAPPING_STATS"
MAPPING_RELATIONSHIP=$(printf '%s\n' "$MAPPING_STATS" | awk -F'|' 'NR==1{print $1;exit}')
case "$MAPPING_RELATIONSHIP" in
  linked_equal) ui_print "- Brightness/Apollo: Level and nit are linked one-to-one" ;;
  separate_nit) ui_print "! Brightness/Apollo: Level matches, but nit differs; separate editing will be used" ;;
  *) fail_install E_MAPPING_RELATIONSHIP "Unknown mapping relationship: $MAPPING_RELATIONSHIP" ;;
esac
ui_print "  Relationship stats: $MAPPING_STATS"

if awk -v p="$TARGET_ETC" '$5==p || index($5,p"/")==1 {found=1} END{exit !found}' /proc/self/mountinfo 2>/dev/null; then
  fail_install E_TARGET_ALREADY_MOUNTED "$TARGET_ETC is already overlaid; disable conflicting modules and reboot"
fi

for d in /data/adb/modules/*; do
  [ -d "$d" ] || continue
  [ "$d" = "$MODPATH" ] && continue
  [ -f "$d/disable" ] && continue
  if grep -R -q '/my_product/vendor/etc' "$d"/*.sh "$d/module.prop" 2>/dev/null; then
    fail_install E_MODULE_CONFLICT "Possible conflict with enabled module: $(basename "$d"); disable it and reboot"
  fi
done

ORIGINAL="$MODPATH/data/original/etc"
GENERATED="$MODPATH/data/generated/etc"
mkdir -p "$ORIGINAL/EyeProtect" "$GENERATED" "$MODPATH/config" \
  "$MODPATH/data/backups" "$MODPATH/data/state" "$MODPATH/data/logs"

ui_print "- 从设备真实分区复制原厂配置"
: > "$MODPATH/data/state/managed_files.list"
copy_managed_file() {
  n="$1"
  [ -f "$TARGET_ETC/$n" ] || return 1
  cp -af "$TARGET_ETC/$n" "$ORIGINAL/$n" || return 1
  printf '%s\n' "$n" >> "$MODPATH/data/state/managed_files.list"
}

# Keep the immutable snapshot limited to files that configctl can actually
# parse and regenerate. Vendor builds often contain additional display_*.xml
# files with unrelated schemas; validating those caused false install aborts.
for n in "$BRIGHTNESS_FILE" "$APOLLO_FILE" "$SENSOR_FILE" \
  "$DBVGAIN_FILE" "$PANEL_DEMURA_FILE" \
  display_brightness_app_list.xml multimedia_display_brightness_config.xml \
  multimedia_display_uir_config.xml multimedia_display_voltage_limit.xml; do
  copy_managed_file "$n" || fail_install E_COPY_MANAGED "Failed to snapshot: $n"
done

for n in multimedia_display_adfr2minfps_config.xml \
  multimedia_display_dbi_config.xml multimedia_display_demura_config.xml; do
  [ ! -f "$TARGET_ETC/$n" ] || copy_managed_file "$n" || fail_install E_COPY_OPTIONAL "Failed to snapshot optional file: $n"
done
if [ -d "$TARGET_ETC/EyeProtect" ]; then
  for f in "$TARGET_ETC"/EyeProtect/*.xml; do
    if [ -f "$f" ]; then
      n="EyeProtect/$(basename "$f")"
      cp -af "$f" "$ORIGINAL/$n" || fail_install E_COPY_EYEPROTECT "Failed to snapshot: $n"
      printf '%s\n' "$n" >> "$MODPATH/data/state/managed_files.list"
    fi
  done
fi

printf '%s\n' "$BRIGHTNESS_FILE" > "$MODPATH/data/state/brightness_file"
printf '%s\n' "$APOLLO_FILE" > "$MODPATH/data/state/apollo_file"
printf '%s\n' "$SENSOR_FILE" > "$MODPATH/data/state/sensor_file"
printf '%s\n' "$MAPPING_STATS" > "$MODPATH/data/state/mapping_relationship"

chmod 0755 "$MODPATH/bin/configctl" "$MODPATH"/*.sh 2>/dev/null
chmod 0644 "$ORIGINAL"/*.xml "$ORIGINAL"/EyeProtect/*.xml 2>/dev/null

print_diagnostics() {
  logfile="$1"
  [ -s "$logfile" ] || { ui_print "  (diagnostic log is empty: $logfile)"; return; }
  ui_print "- configctl diagnostics:"
  tail -n 60 "$logfile" 2>/dev/null | while IFS= read -r line; do
    ui_print "  $line"
  done
}

ui_print "- Parse factory defaults and create documented JSON"
if ! "$MODPATH/bin/configctl" init; then
  print_diagnostics "$MODPATH/data/logs/install.log"
  fail_install E_CONFIG_INIT "Failed to create config.json"
fi
if ! "$MODPATH/bin/configctl" apply --no-mount; then
  print_diagnostics "$MODPATH/data/logs/apply.log"
  fail_install E_FACTORY_VALIDATE "Factory-derived XML validation failed"
fi

ui_print "- 安装完成"
ui_print "  模块目录: /data/adb/modules/oplus_brightness_control"
ui_print "  手动配置: /data/adb/modules/oplus_brightness_control/config/config.json"
ui_print "  原厂备份: /data/adb/modules/oplus_brightness_control/data/original/etc"
ui_print "  生成文件: /data/adb/modules/oplus_brightness_control/data/generated/etc"
ui_print "  管理器操作按钮会校验并应用 JSON"
ui_print "  KernelSU 可直接打开 WebUI"
ui_print "  修改显示配置前建议安装可信的救砖模块"

set_perm_recursive "$MODPATH" 0 0 0755 0644
set_perm "$MODPATH/bin/configctl" 0 0 0755
set_perm "$MODPATH/customize.sh" 0 0 0755
set_perm "$MODPATH/action.sh" 0 0 0755
set_perm "$MODPATH/post-fs-data.sh" 0 0 0755
set_perm "$MODPATH/post-mount.sh" 0 0 0755
set_perm "$MODPATH/service.sh" 0 0 0755
