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
