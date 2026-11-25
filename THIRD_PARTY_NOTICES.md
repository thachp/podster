# Third-party notices

Podster is MIT-licensed (see `LICENSE`). The files listed here are someone else's work, shipped in this repository
under their own licences. They are kept unmodified, in their own folders, with their licence headers intact. Code
dependencies fetched by Cargo or npm keep their own licence files and aren't listed here.

## Public Suffix List

| | |
| --- | --- |
| File | `third_party/public-suffix-list/public_suffix_list.dat` |
| Licence | Mozilla Public License, v. 2.0 (<https://mozilla.org/MPL/2.0/>), as the file's own header states |
| Source | <https://publicsuffix.org/list/public_suffix_list.dat>, the list's only supported source |
| Retrieved | 2026-11-25 (the list's `VERSION: 2026-11-24_18-53-27_UTC`) |
| SHA-256 | `cd1866797f7e9707269cabaf71e46f522299efadd504cdcd429af486bb620de2` |
| Used for | The API compiles it in and reads the whole list, ICANN and private sections, to refuse a custom hostname that is itself a public suffix (`docs/m6-plan.md`, step 8a) |
| Licence ruling | The MPL-2.0 licence was accepted by the architect on 2026-11-25 |

`third_party/public-suffix-list/SNAPSHOT` records the same source, date and SHA-256 in a form the tests read.
`scripts/public-suffix-list check` verifies the file against it and checks its age (a warning from 60 days, a failure past 90), weekly in CI and before each staging deploy, and `scripts/public-suffix-list refresh` downloads a
new copy and rewrites it. After a refresh, update the date and SHA-256 above. The file is never edited by hand: under
the MPL-2.0, changes to it would have to be published under the same licence.
