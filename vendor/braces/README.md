# Local braces security patch

This private package preserves the upstream `braces` 3.0.3 API and MIT license while bounding nesting to address [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It is named `@diffex-cloud/braces` at version `3.0.3-diffex.1` because this is our reviewed patch, not an upstream fixed release.
Each consuming repository scopes its npm override to the affected dependency chain and tests the installed consumer rather than changing its functionality.

## Provenance

The source is copied from the immutable [npm braces 3.0.3 tarball](https://registry.npmjs.org/braces/-/braces-3.0.3.tgz).
Its npm integrity is `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==` and SHA-1 is `490332f40919452272d55a8480adc0c441358789`.
The library files are source, not generated code.
They retain upstream formatting to make the patch easy to compare.
The unchanged upstream MIT license is in `LICENSE`.
The private manifest pins the existing `fill-range` dependency to the reviewed version `7.1.1`.

The original SHA-256 fingerprints are:

| File               | Original SHA-256                                                   |
| ------------------ | ------------------------------------------------------------------ |
| `index.js`         | `332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4` |
| `lib/compile.js`   | `dc98f22eee3d511785d92a00758d5f0d48efed5f5813bdecc2de430c529b5c9f` |
| `lib/constants.js` | `c18ac5adb57308f1ce42a28552da3a31f5d83709743ebd9a636336813a744d4b` |
| `lib/expand.js`    | `41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7` |
| `lib/parse.js`     | `e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310` |
| `lib/stringify.js` | `379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a` |
| `lib/utils.js`     | `b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7` |
| `LICENSE`          | `35bdd8a44339719441900fb50fbefc5e2dca1ca662cbaed7a687de842c8b70f2` |

## Patch and verification

The parser bounds combined brace and parenthesis nesting to 100 structural levels.
Compile, expand, and stringify independently bound recursive internal nodes, including caller-supplied ASTs.
Expansion parent traversal and recursive array helpers also have fixed bounds, and AST text values must be strings to prevent unchecked native array coercion.
Caller options cannot raise or disable these bounds.
Escaped, quoted, and character-class literal braces retain upstream behavior.
This addresses nesting exhaustion; it does not claim to bound every combinatorial expansion or other resource risk.

Consuming repository tests exercise the actual affected dependency path, micromatch and fast-glob compatibility, public AST entry points, depth boundaries, cycles, alternatives, ranges, and literal handling.
Docker install stages must copy this package before installing local file dependencies.
`npm audit` checks registry dependencies but does not independently establish the security of this private source.
The source requires manual review and the targeted security tests in addition to the repository checks.

## Retirement

Replace the override with an upstream fixed release once its patch, compatibility, and advisory status have been verified.
Remove this private package and its formatting exceptions at that time, while keeping regression coverage for the affected consumer.
Do not relabel this package as an unaffected upstream version or suppress the advisory.
