# P6 历史回归日志归档

归档包含 `final/regression-attempts`、`final/regression-recovery-attempts` 和 `mac-closeout/regression-attempts` 的 2,432 份原始日志及结果。回归清册与文档直接链接的日志仍可在原位置阅读。其余记录可用清册中的原始路径查找归档成员。

归档前的 Git 提交为 `8fa92baaeae8a5e04d4be29b0a88655aeb7b0a9a`。归档 SHA-256 为 `69e8106fe9118ac6e47d6ba2dedcbb7c4702b552aab59dd2d6c955f453784600`。压缩包内的 `SHA256SUMS` 按仓库相对路径索引每一份原始文件。 [历史回归日志](macos-p6-regression-attempts.tar.gz)

在仓库根目录执行以下命令可离线核验。

```sh
archive="$PWD/MACOS-PORTING/evidence/P6/archives/macos-p6-regression-attempts.tar.gz"
shasum -a 256 "$archive"
verify_dir=$(mktemp -d)
tar -xzf "$archive" -C "$verify_dir"
(cd "$verify_dir" && shasum -a 256 -c SHA256SUMS)
```

## Mac 清理迭代冻结候选

`1ece927e` 的源码回归、Full／Slim 打包清单、隔离安装及升级回退、原生自动化和性能证据已归档。共 1,592 份文件，均已从归档逐件复算 SHA-256，并与冻结验收报告引用的哈希核对。归档 SHA-256 为 `3917babb89023913ab6faa1f901653a83c96bc3b632418b39c90c5df7c774209`。 [冻结候选自动化证据](macos-native-1ece927e-automated-validation.tar.gz)

归档中的文件按仓库相对路径保存。按上面的命令替换 `archive` 路径即可解压核验。归档完成后，两份冻结候选通过本机实机验收。 [实机截图与输入](../mac-native-1ece927e/physical-desktop.json) · [实际睡眠唤醒](../mac-native-1ece927e/physical-wake.json)
