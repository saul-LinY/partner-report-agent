# 工作看板 macOS 应用与组件

应用提供“采集权限 / 工作卡片 / 设置”三个页面。WidgetKit 扩展只支持中尺寸，用于展示当前 Mac 的采集状态和周一至周日有效 Session。

```bash
xcodegen generate
xcodebuild -project PartnerReportDesktop.xcodeproj -scheme PartnerReport CODE_SIGNING_ALLOWED=NO build
```

应用与组件必须使用相同 App Group。切换 Apple Developer Team 时，同时更新 `project.yml` 中的 Team、Bundle ID 和 App Group。
