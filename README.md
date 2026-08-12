# OPlus 亮度控制 WebUI - PLG110/120 显示适配

一个面向 OPlus PLG110/PLG120 设备的 KernelSU、Magisk、APatch 亮度配置模块。

模块提供离线 WebUI，用于调整手动亮度上限、自动亮度曲线、应用亮度策略、游戏 EDR、温度/电池限制、HBM 条件以及亮度映射。模块以设备当前的原厂 XML 为基线，每次应用都从只读原厂快照重新生成配置，避免重复修改造成累积误差。

> 当前版本：`1.0.0`  
> 作者：`fnESHJA & Codex`  
> 适配标识：`PLG110/120`  
> 模块 ID：`oplus_brightness_control`

## 本模块通过Vibe Coding编写得来，只在PLG110设备上完成验证，不对其他设备的兼容性做任何保证。请在安装前确保已经安装可信的救砖模块。如果需要适配其他机型，建议自行下载源码之后通过Vibe Coding等方法进行适配，本模块后续很可能不会有后续更新。

## 重要说明

本项目面向与 PLG110/120、P_7 结构相同的 OPlus 显示配置。它不是适用于所有 OPlus 手机的通用模块。

安装器会检查以下条件：

- ARM64 Android。
- `/my_product/vendor/etc` 存在且可读取。
- 存在唯一的亮度配置、Apollo 映射和传感器配置文件。
- 关键 XML 节点、曲线结构、数组长度和 Brightness/Apollo 映射关系符合预期。
- 目标文件没有被其他启用模块或已有挂载覆盖。

不兼容时会自动终止安装，不会使用包内样本覆盖设备文件。安装失败日志会优先保存到：

```text
/storage/emulated/0/Download/OPlusBrightness/install-failed-日期时间.log
```

## 功能概览

### 主页：手动亮度与自动亮度

- 手动亮度最高逻辑等级。
- 自动亮度 Lux→nit 曲线坐标编辑。
- 曲线坐标增加、删除、排序和恢复原厂值。
- 控制点拖动时自动保持 Lux 递增、nit 不下降。
- 竖屏下曲线支持左右移动视窗。
- 空白处单指可上下左右移动视窗，双指可缩放。
- “横屏编辑”支持全屏大尺寸编辑；横屏下控制点和视窗移动可以分别使用。

自动亮度曲线影响的是自动亮度模式下的环境光到目标亮度请求，不直接改变手动滑块上限。最终亮度还会受到 HBM、应用策略、温度、电量和面板映射限制。

### HBM

HBM 单独放在 HBM 页面，并默认锁定。开启危险模式后可调整：

- HBM 环境照度门限。
- HBM CCT 条件。
- HBM 厂商曲线/策略模式编号。

这些参数控制 HBM 何时进入高亮通路，不是直接的 nit 值。降低触发条件可能增加耗电、温升和烧屏风险。

### 应用亮度策略

- 全局应用亮度上限。
- 全局例外应用名单。
- UIR 应用增强和温度门限。
- FOSS type 2/type 4 降亮名单与比例。
- method 2 视频、method 3 短视频/直播、method 4 游戏、method 6 导航/配送、method 8 阅读/浏览。
- 窗口亮度名单和 `limitnit`。
- 已安装应用搜索、用户/系统应用区分和手动包名输入。

同一个应用可能同时命中多个名单。应用策略、窗口限制、温控和全局限制可能叠加，实际亮度通常取更保守的限制结果。

### 游戏

- method 4 游戏名单。
- 全局游戏亮度策略。
- factor 25 和 factor 27 的 EDR 原始/增强曲线。
- ADFR 游戏名单单独显示为刷新率联动名单。

当前 XML 只提供全局游戏 EDR 曲线，不支持每个游戏独立一套 EDR 曲线。因此名单内游戏共用 factor 25/27 参数。

### 温度与电池

- 低温/低电压亮度矩阵。
- 强制温控阈值。
- UIR 温度阈值。
- Dolby 0～21 档温度亮度上限。

普通模式允许恢复原厂或加强保护。提高温度阈值、提高低电量亮度上限或放宽 Dolby 保护必须开启危险模式。

### 其他联动

- 暗环境降亮 Lux/比例曲线。
- 双光感融合、光感常开和暗环境平滑。
- 双亮度动画、Half Vsync。
- 舒适亮度运动模式。
- backlightStat 统计参数。
- ADFR 面板 nit、暗环境 Lux 和最低刷新率条件。
- DBI 开关与应用名单。

统计参数和 DBI/ADFR 联动不等于直接提高屏幕峰值亮度；界面会对这些项目进行说明。

### 亮度映射与硬件标定

危险模式下可进入：

- `display_brightness_config_*` 的 Brightness 亮度表。
- `display_apollo_list_*` 的 Apollo 映射。
- 亮度映射曲线、分页、首末页、正序/逆序显示。
- nit/DBV 统一倍率和单行覆盖。
- DBV/Gamma、Demura、EyeProtect。

安装时会逐行比较 Brightness 与 Apollo：

- 如果 Level 和 nit 全部一致，默认使用联动编辑。
- 如果 Level 对齐但 nit 不一致，默认分开编辑。
- 即使原厂一致，也可以在危险模式下强制分开编辑，但界面会持续显示警告。

Brightness nit 主要描述亮度策略/请求，Apollo nit 和 DBV 属于面板驱动映射。两者分开修改可能导致亮度跳变、钳位或模式切换异常。

DBV 是面板驱动的数字背光值，模块始终限制 `DBV ≤ 4095`。这是当前配置结构的 12 位硬件/协议范围，危险模式也不能解除。

## 安装方法

1. 在 KernelSU、Magisk 或 APatch 管理器中安装：

   ```text
   OPlus 亮度控制 WebUI-PLG110_120-v1.0.0.zip
   ```

2. 等待安装器检查设备结构。
3. 安装成功后重启设备。
4. 在 KernelSU WebUI 或管理器模块操作页面打开模块。
5. 首次使用建议先在“设置”页面创建备份，再修改参数。

模块不会主动重启显示服务。保存并应用后通常需要重启设备，才能确保 OPlus 显示服务重新读取 XML。

## WebUI 使用方法

### 修改普通亮度项目

1. 打开目标页面。
2. 点击项目右侧的 `?` 查看作用、单位、触发条件和副作用。
3. 修改数值或名单。
4. 点击右下角“保存并应用”。
5. 等待后台任务完成，并根据状态提示重启设备。

每个页面末尾都有“恢复本页原厂值”。设置页面的“全部恢复原厂值”会恢复亮度配置，但会保留当前危险模式解锁状态。

### 编辑自动亮度曲线

- 修改表格中的 Lux/nit 数值后会自动排序。
- 拖动控制点时，前后节点会遵守 Lux 递增规则。
- 前面节点提高后，后面低于它的节点会自动抬高。
- 竖屏可在画布空白处单指拖动左右移动视窗。
- 空白处单指可平移，双指可缩放。
- 需要精细操作时点击“横屏编辑”。
- “恢复该曲线原厂值”只恢复自动曲线，不影响其他设置。

### 开启危险模式

危险模式可能造成黑屏、烧屏、异常温升、色偏或无法正常进入系统。

开启前建议：

- 先创建 WebUI 配置备份。
- 安装可信来源的救砖/开机禁用模块。
- 保留 USB 调试、Recovery 或其他可恢复手段。

在设置页点击危险模式后，阅读警告并点击确认即可，无需输入确认文字。WebUI 会自动写入 `I_UNDERSTAND_THE_RISK`。

## 配置文件和目录

安装后的模块目录：

```text
/data/adb/modules/oplus_brightness_control/
├── config/config.json          # 当前用户配置，可手动编辑
├── config/defaults.json        # 安装时读取的原厂默认配置
├── data/original/etc/          # 只读原厂 XML 快照
├── data/generated/etc/         # 根据 JSON 生成的 XML
├── data/backups/               # 自动配置备份，最多保留 10 份
├── data/state/status.json      # 当前状态
├── data/state/mounts.list      # 实际挂载文件清单
└── data/logs/apply.log         # 应用和校验日志
```

`config.json` 使用标准 JSON。每个配置项包含：

```json
{
  "value": 2000,
  "_comment": "项目作用、单位、触发条件、调高/调低效果和风险说明",
  "unit": "nit",
  "source": "原厂 XML 节点",
  "original": 1800,
  "safe_range": [0, 2400]
}
```

手动修改时只修改 `value`，不要删除 `_comment`、`original`、`safe_range` 或末尾的 `_end`。曲线和数组项目需要保持数组长度、顺序和配对关系正确。修改后可以在管理器点击模块的“操作/执行”按钮应用。

普通模式的应用亮度软上限为原厂应用名单最大显式 nit 的 120%。当前 P_7 参考样本为：

```text
2000 × 1.20 = 2400 nit
```

这只是配置请求上限，不代表面板实际可以达到 2400 nit。参考样本 Apollo 映射最高约 1800 nit。

## 备份、导入和恢复

设置页面支持：

- 创建模块内备份。
- 下载当前 JSON。
- 保存到 `/sdcard/Download/OPlusBrightness/`。
- 从本地 JSON 导入。
- 全部恢复原厂值。

同一设备且原厂哈希一致时，可以完整导入配置。设备指纹不同但 XML 结构兼容时，模块会跳过硬件标定和温控矩阵，保留通用亮度/应用设置。结构不兼容的配置会被拒绝。

## 故障排查

### 保存并应用失败

查看：

```text
/data/adb/modules/oplus_brightness_control/data/logs/apply.log
```

WebUI 会显示后台任务号。日志中重点查看 `E_` 开头的错误、失败 XML 文件和具体节点。

### 安装失败

优先查看：

```text
/storage/emulated/0/Download/OPlusBrightness/install-failed-latest.log
```

如果共享存储不可写，安装器会依次尝试 `/sdcard/Download/OPlusBrightness`、`/data/media/0/Download/OPlusBrightness` 和 `/data/local/tmp/OPlusBrightness`。

### 修改后亮度没有变化

可能原因：

- 显示服务缓存了旧 XML，需要重启。
- 请求值超过 Apollo/面板物理映射。
- 温度、电池、Dolby 或应用策略仍在限亮。
- 修改的是统计、ADFR 或 DBI 条件，不是直接亮度上限。
- 应用命中了多个策略，最终采用了更低限制。

### 回滚

1. 在管理器中禁用模块。
2. 重启设备。
3. 如果无法正常启动，使用 KernelSU/Magisk/APatch 的模块禁用功能或 Recovery 删除模块。

模块只对实际发生变化的 XML 逐文件挂载，不整目录覆盖系统 `etc`。禁用或卸载并重启后，系统文件会恢复原状。

## 挂载和 root 检测说明

模块使用逐文件 bind mount，影响范围小于整目录挂载，但挂载记录仍可能出现在 `/proc/self/mountinfo`。本项目不包含 Zygisk、属性伪装、常驻网络服务或 root 检测绕过代码，也不保证隐藏 root。

模块不使用 KernelSU metamodule。metamodule 全局只能有一个，且不保证覆盖 `/my_product/vendor/etc`，因此本模块使用自己的逐文件挂载流程。

## 开发和测试

源码目录：

```text
OPlus_亮度控制_WebUI/
```

运行测试：

```powershell
python -m unittest discover -s OPlus_亮度控制_WebUI/tests -v
```

重新构建 ZIP：

```powershell
python build_oplus_brightness_module.py
```

构建产物：

```text
OPlus_亮度控制_WebUI-PLG110_120-v1.0.0.zip
```

## 免责声明

显示亮度、温控、Gamma、Demura 和 DBV 属于设备显示硬件与厂商服务的联合控制。错误配置可能造成黑屏、烧屏、色偏、异常温升、耗电增加或系统无法正常启动。使用者应自行备份并承担修改风险。
