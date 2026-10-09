# Third-party names and marks

Token Grill uses provider marks to identify configured services. All provider
names and marks remain the property of their respective owners. Token Grill
is independent and is not endorsed by or affiliated with those providers.

All seven provider marks come from [LobeHub's monochrome icon set](https://lobehub.com/icons?type=mono),
at [revision c385b2b8d1f9e19aa86e628d4e23c91ee1111a47](https://github.com/lobehub/lobe-icons/tree/c385b2b8d1f9e19aa86e628d4e23c91ee1111a47).
The vector geometry is unchanged; currentColor is replaced with white or black
for reliable contrast in GNOME Shell and GTK. LobeHub's MIT license and copyright
notice are included in resources/icons/providers/LOBEHUB-LICENSE.txt.

Regenerate the assets and this provenance with `node tools/import-provider-icons.mjs`.
The source URL and packaged checksum of every asset are in resources/provider-assets.json.

- openai light: SHA-256 `8f281b924400eb1a16b9a0f5fc6eb22db4d517bfee1446c21b2038fce3d6bf4d`
- openai dark: SHA-256 `a6f64c2670a20c03c134ae0ccf1dab4dfd817f10a41da21547f720c5c1fb6820`
- claude light: SHA-256 `7b22b4575c49d817d6051da95613c6d6778240b519c28b072ce1b12fe4fefec8`
- claude dark: SHA-256 `cfa161e388edfe5877adc5095cbe11776dc84df9a29a586a85163445c64eea4b`
- kiro light: SHA-256 `cdf9cb747752f4fec54e920a7a7836b982953730d0a63d1b7a013839f5e88a90`
- kiro dark: SHA-256 `83b64eeed82cede4ecf5a193e2b788217044a74237e750c2440af8e15b169539`
- antigravity light: SHA-256 `ed9f4ad191f0a3d987bcce9064a4f88ae4f87d6987df35f2084d60d963bdce62`
- antigravity dark: SHA-256 `00b26449ced11b2da873a3fcffa44ca9e478a8d96214b5cf703df85ff24b2123`
- deepseek light: SHA-256 `6190aed9463e2d4d3f6ef8b6d72ae06e2c5ebbbfc789591c7775aefef5475c83`
- deepseek dark: SHA-256 `c01247aad363e2758eaab9f2603eba600e3b712b2408a0977c64e9106937da55`
- kimi light: SHA-256 `b1a91e6d353f9a0a5be3866509fa7f8a8a1c036964d22749a237d96e50803378`
- kimi dark: SHA-256 `1a57c7b223b888e323b44edc816300640f7630d782c1b5032821868fe18ed59d`
- opencode light: SHA-256 `70d77b59997fb75c629e2f2a6dddb10d1c96e80c293e40744f38f29fdc2a3059`
- opencode dark: SHA-256 `d11b7f3f78ed67d47c9851a11c92a69448c46f6e91156dbd3cff43f397360a50`

## Bundled TOML parser

Token Grill bundles [smol-toml](https://github.com/squirrelchat/smol-toml)
to read Kimi CLI configuration. Its BSD-3-Clause license and copyright notice
are included in resources/SMOL-TOML-LICENSE.txt.
