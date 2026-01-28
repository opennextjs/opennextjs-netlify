# Changelog

## [4.41.6](https://github.com/opennextjs/opennextjs-netlify/compare/plugin-nextjs-v4.41.5...plugin-nextjs-v4.41.6) (2026-01-28)


### Bug Fixes

* lazy-load HTMLRewriter WASM only when needed ([#3390](https://github.com/opennextjs/opennextjs-netlify/issues/3390)) ([f1d2f1a](https://github.com/opennextjs/opennextjs-netlify/commit/f1d2f1a5a286ec7be49f24604c1083076f28de9c))

## [4.41.5](https://github.com/opennextjs/opennextjs-netlify/compare/plugin-nextjs-v4.41.4...plugin-nextjs-v4.41.5) (2026-01-08)


### Bug Fixes

* **v4:** make `fetch` and `self` both be reassignable instead of `const` ([#3360](https://github.com/opennextjs/opennextjs-netlify/issues/3360)) ([b4f2906](https://github.com/opennextjs/opennextjs-netlify/commit/b4f2906cad4aad4b31a720073c5be3adfe12d256))

## [4.41.4](https://github.com/opennextjs/opennextjs-netlify/compare/plugin-nextjs-v4.41.3...plugin-nextjs-v4.41.4) (2026-01-05)


### Bug Fixes

* don't follow redirects for rewrites ([#2423](https://github.com/opennextjs/opennextjs-netlify/issues/2423)) ([e59c617](https://github.com/opennextjs/opennextjs-netlify/commit/e59c617b29db7647e81dcdaf7788644521dc6636))
* use modern import attributes syntax for JSON imports ([#3352](https://github.com/opennextjs/opennextjs-netlify/issues/3352)) ([672cdcd](https://github.com/opennextjs/opennextjs-netlify/commit/672cdcd9019b896129cf5834da1f6c10cec9373b))

## [4.41.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.41.2...plugin-nextjs-v4.41.3) (2023-12-08)


### Bug Fixes

* check type before using string-only method ([#2393](https://github.com/netlify/next-runtime/issues/2393)) ([06f0e0c](https://github.com/netlify/next-runtime/commit/06f0e0c4b10e76e667e4461b2b5a04604e2588b9))

## [4.41.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.41.1...plugin-nextjs-v4.41.2) (2023-11-15)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.6 ([#2368](https://github.com/netlify/next-runtime/issues/2368)) ([f73cbc0](https://github.com/netlify/next-runtime/commit/f73cbc02891ce8c9aa679958d8171cbe5b96ddfc))

## [4.41.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.41.0...plugin-nextjs-v4.41.1) (2023-10-19)


### Bug Fixes

* copy `vendor` over for local dev ([#2341](https://github.com/netlify/next-runtime/issues/2341)) ([e43fcf2](https://github.com/netlify/next-runtime/commit/e43fcf28f2e75219ff607ac347f2254982b3365f))

## [4.41.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.40.2...plugin-nextjs-v4.41.0) (2023-10-17)


### Features

* add blob storage ([#2287](https://github.com/netlify/next-runtime/issues/2287)) ([5da5a8c](https://github.com/netlify/next-runtime/commit/5da5a8c625f22edb9fda1b13473a5a5f8d7e0428))


### Bug Fixes

* improve support for new requireHooks update ([#2313](https://github.com/netlify/next-runtime/issues/2313)) ([e354b73](https://github.com/netlify/next-runtime/commit/e354b73ac2c06f8a45d22cba008d8df5dbd341a9))

## [4.40.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.40.1...plugin-nextjs-v4.40.2) (2023-10-02)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.4 ([#2279](https://github.com/netlify/next-runtime/issues/2279)) ([49e1974](https://github.com/netlify/next-runtime/commit/49e1974c3a82ec006a67621ce1b924ca1ed6dce7))
* **deps:** update dependency @netlify/ipx to ^1.4.5 ([#2311](https://github.com/netlify/next-runtime/issues/2311)) ([d1e5a8e](https://github.com/netlify/next-runtime/commit/d1e5a8e977fc1724ca30f8366e114a41f72120cc))
* vendor deno dependencies ([#2302](https://github.com/netlify/next-runtime/issues/2302)) ([a8d06ab](https://github.com/netlify/next-runtime/commit/a8d06abe28cf1797f165c2615ef790e783e5d5c6))

## [4.40.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.40.0...plugin-nextjs-v4.40.1) (2023-08-21)


### Bug Fixes

* improves support for __NEXT_PRIVATE_PREBUNDLED_REACT ([#2236](https://github.com/netlify/next-runtime/issues/2236)) ([4261de7](https://github.com/netlify/next-runtime/commit/4261de73db3a678c4526b15f58acb3bd5711f98a))
* pass packagePath down to rsc edge manifest ([#2269](https://github.com/netlify/next-runtime/issues/2269)) ([3517973](https://github.com/netlify/next-runtime/commit/3517973dd6507a07303f6875b629acb0f976514b))

## [4.40.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.39.4...plugin-nextjs-v4.40.0) (2023-08-14)


### Features

* support new monorepo setup ([#2260](https://github.com/netlify/next-runtime/issues/2260)) ([7185d62](https://github.com/netlify/next-runtime/commit/7185d6287a3aad18771d905192b1e4918be08a4b))

## [4.39.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.39.3...plugin-nextjs-v4.39.4) (2023-08-10)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.3 ([#2256](https://github.com/netlify/next-runtime/issues/2256)) ([ffdf101](https://github.com/netlify/next-runtime/commit/ffdf101db31a15f08cf9559c19406be24c472bb7))
* don't ever execute middleware in lambda ([#2249](https://github.com/netlify/next-runtime/issues/2249)) ([b9e87d1](https://github.com/netlify/next-runtime/commit/b9e87d1962e5c14e0a764dbf69957aa2d593f31a))

## [4.39.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.39.2...plugin-nextjs-v4.39.3) (2023-08-03)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.2 ([#2240](https://github.com/netlify/next-runtime/issues/2240)) ([b911230](https://github.com/netlify/next-runtime/commit/b91123091492bb10b726a2b911482bff67f8834a))

## [4.39.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.39.1...plugin-nextjs-v4.39.2) (2023-08-01)


### Bug Fixes

* ISR 404 pages should be cached ephemerally ([#2233](https://github.com/netlify/next-runtime/issues/2233)) ([d7aad8a](https://github.com/netlify/next-runtime/commit/d7aad8a4b11d563b0336476862823d852f4f6e44))

## [4.39.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.39.0...plugin-nextjs-v4.39.1) (2023-07-11)


### Bug Fixes

* use native path matching for prebundled react conditional ([#2206](https://github.com/netlify/next-runtime/issues/2206)) ([ba036fb](https://github.com/netlify/next-runtime/commit/ba036fbcce431b8b95f006ebca72e2bd07741a15))

## [4.39.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.38.1...plugin-nextjs-v4.39.0) (2023-07-03)


### Features

* Use `none` bundler for SSR Routes ([#2084](https://github.com/netlify/next-runtime/issues/2084)) ([4b3d3f4](https://github.com/netlify/next-runtime/commit/4b3d3f46060448e2527d94eda952314142150ddd))


### Bug Fixes

* **deps:** update dependency pathe to ^0.3.0 ([#2199](https://github.com/netlify/next-runtime/issues/2199)) ([87391e1](https://github.com/netlify/next-runtime/commit/87391e162588910459d9ca0eb7080c04bb713988))
* edge cases for custom react module resolution ([#2188](https://github.com/netlify/next-runtime/issues/2188)) ([6b527be](https://github.com/netlify/next-runtime/commit/6b527be4473032c2e22ed67c819ef662d410f457))
* preserve original path after middleware rewrite ([#2177](https://github.com/netlify/next-runtime/issues/2177)) ([9c6ec9f](https://github.com/netlify/next-runtime/commit/9c6ec9f669b8325f6cd4a3ed61446dc7cf550d3a))

## [4.38.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.38.0...plugin-nextjs-v4.38.1) (2023-06-22)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.1 ([#2167](https://github.com/netlify/next-runtime/issues/2167)) ([c295bc2](https://github.com/netlify/next-runtime/commit/c295bc23bd769e0d946a40d75ee7340f4d5cdf9d))
* optionally chain server functions when selecting react version ([#2179](https://github.com/netlify/next-runtime/issues/2179)) ([e63fcf0](https://github.com/netlify/next-runtime/commit/e63fcf0f98b52a830d8b328be803755ba91942ff))

## [4.38.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.37.4...plugin-nextjs-v4.38.0) (2023-06-16)


### Features

* provide display name for split api routes ([#2155](https://github.com/netlify/next-runtime/issues/2155)) ([10250a0](https://github.com/netlify/next-runtime/commit/10250a01cc422a36a53c079872b5cd84b62be3dd))


### Bug Fixes

* bundle dynamic API routes correctly with split-api-routes ([#2154](https://github.com/netlify/next-runtime/issues/2154)) ([dc7c479](https://github.com/netlify/next-runtime/commit/dc7c4791280286c85fc5676ab1ee82db04567a12))
* ensure next-server patches only run on Netlify ([#2117](https://github.com/netlify/next-runtime/issues/2117)) ([6bdaec1](https://github.com/netlify/next-runtime/commit/6bdaec1d6d68549939c65608d37d59b3a925a3ef))
* ensures compatibility with Next.js 13.4 (support for some features still en-route) ([9f85472](https://github.com/netlify/next-runtime/commit/9f8547260f654ad89a6412c6deaeb096ffd56671))
* new ISR cache handling to resolve regression in 13.4 ([#2165](https://github.com/netlify/next-runtime/issues/2165)) ([6817cc9](https://github.com/netlify/next-runtime/commit/6817cc93b8147edc95558ad8ea0f9fdb058832e1))
* strip domain from ipx edge functions path ([#2098](https://github.com/netlify/next-runtime/issues/2098)) ([#2099](https://github.com/netlify/next-runtime/issues/2099)) ([c9ab983](https://github.com/netlify/next-runtime/commit/c9ab9835844aad926df47e800226687bcb65592c))
* uses pre-bundled React modules for App Router paths ([9f85472](https://github.com/netlify/next-runtime/commit/9f8547260f654ad89a6412c6deaeb096ffd56671))

## [4.37.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.37.3...plugin-nextjs-v4.37.4) (2023-05-30)


### Bug Fixes

* pass only first language to next-server to match platform redirects support ([#2138](https://github.com/netlify/next-runtime/issues/2138)) ([aca3dc6](https://github.com/netlify/next-runtime/commit/aca3dc6d09aaf5586f3acfe41f7e12cb504c3325))

## [4.37.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.37.2...plugin-nextjs-v4.37.3) (2023-05-30)


### Bug Fixes

* remove edge functions beta label ([#2133](https://github.com/netlify/next-runtime/issues/2133)) ([7a10491](https://github.com/netlify/next-runtime/commit/7a10491647fcaf71e5ed38a999306065ed56ac70))
* tracing root use `appDir` as fallback ([#2136](https://github.com/netlify/next-runtime/issues/2136)) ([64280e5](https://github.com/netlify/next-runtime/commit/64280e5a424d09dd04241d89b2f9335c1d997586))

## [4.37.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.37.1...plugin-nextjs-v4.37.2) (2023-05-22)


### Bug Fixes

* checks when Next.js' implementation of ResponseCookies._headers is undefined now ([#2119](https://github.com/netlify/next-runtime/issues/2119)) ([f051e22](https://github.com/netlify/next-runtime/commit/f051e227ca10ddc228b1d044eb835fe66fd1d733))
* don't deploy metadata files to CDN ([#2104](https://github.com/netlify/next-runtime/issues/2104)) ([ba3a430](https://github.com/netlify/next-runtime/commit/ba3a430c74cf951ac27e07c6808679b887702950))
* guard split api routes behaviour by next version ([#2125](https://github.com/netlify/next-runtime/issues/2125)) ([a8bb0e3](https://github.com/netlify/next-runtime/commit/a8bb0e3db3c7d550921bc3ed54d0ec575f1a2191))
* resolve follow-redirects from runtime package, so it's available also in auto-installs ([#2124](https://github.com/netlify/next-runtime/issues/2124)) ([49ada27](https://github.com/netlify/next-runtime/commit/49ada272e732542a85f2618c065080444e1c299c))

## [4.37.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.37.0...plugin-nextjs-v4.37.1) (2023-05-17)


### Bug Fixes

* clientContext isn't available in background functions ([#2121](https://github.com/netlify/next-runtime/issues/2121)) ([df0f6bc](https://github.com/netlify/next-runtime/commit/df0f6bcecee39f203327598120ad3ec778e45624))
* support named & default export for middleware in ntl dev ([#2116](https://github.com/netlify/next-runtime/issues/2116)) ([b31f858](https://github.com/netlify/next-runtime/commit/b31f858e135d5727729c5c6336ce6519f60678d6))

## [4.37.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.36.1...plugin-nextjs-v4.37.0) (2023-05-15)


### Features

* split up API Routes + use .nft.json files to make builds fast ([#2058](https://github.com/netlify/next-runtime/issues/2058)) ([d98efc1](https://github.com/netlify/next-runtime/commit/d98efc19852089a4a586170f27ed7c5cb1b5763a))


### Bug Fixes

* **deps:** update dependency @netlify/functions to ^1.5.0 ([#2096](https://github.com/netlify/next-runtime/issues/2096)) ([2eba019](https://github.com/netlify/next-runtime/commit/2eba019675819c4d04da6824337609ed5672ab57))
* **deps:** update dependency @netlify/functions to ^1.6.0 ([#2107](https://github.com/netlify/next-runtime/issues/2107)) ([5ee2fce](https://github.com/netlify/next-runtime/commit/5ee2fce03bf0fadd7f8e06f60963e4c0243c2aee))
* follow-up to split-api revalidate behaviour ([#2113](https://github.com/netlify/next-runtime/issues/2113)) ([cce048a](https://github.com/netlify/next-runtime/commit/cce048ac0b301e47e8f3e8c28d8a5ebe1d3fa546))
* support api routes at index of folder ([#2101](https://github.com/netlify/next-runtime/issues/2101)) ([cc9ed84](https://github.com/netlify/next-runtime/commit/cc9ed84652e21d52dabe1114dbe64aad288672bc))

## [4.36.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.36.0...plugin-nextjs-v4.36.1) (2023-05-08)


### Bug Fixes

* add shim for `require('node:buffer')` ([#2050](https://github.com/netlify/next-runtime/issues/2050)) ([e007b08](https://github.com/netlify/next-runtime/commit/e007b08aad356674279ab6649ef4e27d355918f0))
* Legacy fallback env var ([#2074](https://github.com/netlify/next-runtime/issues/2074)) ([aad9e5f](https://github.com/netlify/next-runtime/commit/aad9e5f738e5f3e1391e1c0e8f65a526bcbc9ac8))
* make large lambda warning message more informative ([#2057](https://github.com/netlify/next-runtime/issues/2057)) ([b4cb75b](https://github.com/netlify/next-runtime/commit/b4cb75b7d71901aa8c1902067ffafecad19fd9d8))
* resolve next-server from next app directory and not from plugin ([#2059](https://github.com/netlify/next-runtime/issues/2059)) ([38f34c7](https://github.com/netlify/next-runtime/commit/38f34c7d8f7f06c96073ebed54675fea38eca7fa))
* Respect `pageExtensions` config setting ([#2073](https://github.com/netlify/next-runtime/issues/2073)) ([940cbbc](https://github.com/netlify/next-runtime/commit/940cbbc38d320677bdc8ade4616d1733ebfda2c7))
* update next to 13.3.0 & ensure compatibility ([#2056](https://github.com/netlify/next-runtime/issues/2056)) ([75ed977](https://github.com/netlify/next-runtime/commit/75ed977553edc36ac018191bee5bba08b800f722))
* workaround netlify-cli not matching prod ([#2030](https://github.com/netlify/next-runtime/issues/2030)) ([fd29ea5](https://github.com/netlify/next-runtime/commit/fd29ea5b7b608d71fcb111c17a92f3dec6d021a9))

## [4.36.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.35.0...plugin-nextjs-v4.36.0) (2023-04-24)


### Features

* add Generator to edge functions ([#2019](https://github.com/netlify/next-runtime/issues/2019)) ([b341938](https://github.com/netlify/next-runtime/commit/b341938ec9807c93b0f0484b40848d727eeeb265))


### Bug Fixes

* default to target server, not serverless ([#2060](https://github.com/netlify/next-runtime/issues/2060)) ([61c2458](https://github.com/netlify/next-runtime/commit/61c24583be0c45def82f51d8c7757bb91ec5fc79))

## [4.35.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.34.0...plugin-nextjs-v4.35.0) (2023-04-17)


### Features

* support edge runtime key ([#2036](https://github.com/netlify/next-runtime/issues/2036)) ([b7b9392](https://github.com/netlify/next-runtime/commit/b7b939210661560c623cf0951597362a27d771b9))


### Bug Fixes

* ensure appDir routes with null dataRoutes are not added to edge manifest for rsc-data ([#2044](https://github.com/netlify/next-runtime/issues/2044)) ([2f31acb](https://github.com/netlify/next-runtime/commit/2f31acbb262a2caa8ed3e90bbec27d131be0e1d0))
* now data routes for dynamic routes filter even when null when creating the RSC data router ([#2041](https://github.com/netlify/next-runtime/issues/2041)) ([5fa1435](https://github.com/netlify/next-runtime/commit/5fa14355428151f0c9748d72d96f3aea90f02bbd))
* typo in comment ([#2049](https://github.com/netlify/next-runtime/issues/2049)) ([447b7d4](https://github.com/netlify/next-runtime/commit/447b7d48b5bf1876efbc09b6d3b340c926f3915d))

## [4.34.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.33.0...plugin-nextjs-v4.34.0) (2023-04-10)


### Features

* use edge function layer for ipx ([#1880](https://github.com/netlify/next-runtime/issues/1880)) ([56c7828](https://github.com/netlify/next-runtime/commit/56c78282662d9f0c47e85e4a0b478f2a354e9c16))


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.4.0 ([#2031](https://github.com/netlify/next-runtime/issues/2031)) ([03f60bb](https://github.com/netlify/next-runtime/commit/03f60bbfd67ba71b2db4fcfba0f2f82fc10bfdfc))
* routes with null data routes can be filtered now ([#2018](https://github.com/netlify/next-runtime/issues/2018)) ([7c1673b](https://github.com/netlify/next-runtime/commit/7c1673b6b09a3b0461e92c6c54afb517d95954c3))
* support setting cookies from MiddlewareResponse ([#2027](https://github.com/netlify/next-runtime/issues/2027)) ([a630ab4](https://github.com/netlify/next-runtime/commit/a630ab41e8a4d0f04e8de4b19a8886705a6b0fe8))

## [4.33.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.32.2...plugin-nextjs-v4.33.0) (2023-03-27)


### Features

* add generator meta data for framework generated Netlify Functions ([#1999](https://github.com/netlify/next-runtime/issues/1999)) ([e5ddcd2](https://github.com/netlify/next-runtime/commit/e5ddcd24f0662af2e36ba237a61a1d05b8f58df4))
* refresh hooks api implementation ([#1950](https://github.com/netlify/next-runtime/issues/1950)) ([fb93b54](https://github.com/netlify/next-runtime/commit/fb93b5469c570616134d53c10fbed1f7ef78e334))


### Bug Fixes

* data route rewrite for i18n root route ([#2002](https://github.com/netlify/next-runtime/issues/2002)) ([4f6cdd9](https://github.com/netlify/next-runtime/commit/4f6cdd93eee5b15bee723e20cc702efa3497121f))
* do not escape HTML ([#2007](https://github.com/netlify/next-runtime/issues/2007)) ([d4cd121](https://github.com/netlify/next-runtime/commit/d4cd121a113bb540f49229d51ee31ca28d04eb13))
* updated redirect data urls ([#1928](https://github.com/netlify/next-runtime/issues/1928)) ([1edaacb](https://github.com/netlify/next-runtime/commit/1edaacb11297bcc1b8865320579c7ecbd703186f))
* use `IMAGE_FUNCTION_NAME` constant ([#2001](https://github.com/netlify/next-runtime/issues/2001)) ([24eaaab](https://github.com/netlify/next-runtime/commit/24eaaab048a78c0ba4d7f283c11d11d02b819b01))
* use separate watcher script for middleware in dev ([#1831](https://github.com/netlify/next-runtime/issues/1831)) ([92e209f](https://github.com/netlify/next-runtime/commit/92e209f177312d4c4e6b64f8feb6c80670e46d8d))

## [4.32.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.32.1...plugin-nextjs-v4.32.2) (2023-03-14)


### Bug Fixes

* make error message matching more generic ([#1988](https://github.com/netlify/next-runtime/issues/1988)) ([cfc8e96](https://github.com/netlify/next-runtime/commit/cfc8e966c90490e5760e192c1aef243f5f2c3aa6))

## [4.32.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.32.0...plugin-nextjs-v4.32.1) (2023-03-13)


### Bug Fixes

* use the same id for importing and checking error ([#1984](https://github.com/netlify/next-runtime/issues/1984)) ([62e2efe](https://github.com/netlify/next-runtime/commit/62e2efe02a01c55a486070fceb7538ed466629c1))

## [4.32.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.31.0...plugin-nextjs-v4.32.0) (2023-03-13)


### Features

* add multiple set-cookie headers in middleware ([#1970](https://github.com/netlify/next-runtime/issues/1970)) ([32b31c6](https://github.com/netlify/next-runtime/commit/32b31c601dd07033ab89e2b53f963cc17d422c28))


### Bug Fixes

* remove fs access which isn't available in edge functions ([#1980](https://github.com/netlify/next-runtime/issues/1980)) ([6546641](https://github.com/netlify/next-runtime/commit/6546641a2f393a0a64b548be7a440b663add0cbb))

## [4.31.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.30.4...plugin-nextjs-v4.31.0) (2023-03-06)


### Features

* make edge image opt-in instead of opt-out ([#1935](https://github.com/netlify/next-runtime/issues/1935)) ([7a63d2f](https://github.com/netlify/next-runtime/commit/7a63d2f0cbd168916db271a9dad9d3e86024965f))

## [4.30.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.30.3...plugin-nextjs-v4.30.4) (2023-02-06)


### Bug Fixes

* add `AsyncLocalStorage` to `globalThis` ([#1907](https://github.com/netlify/next-runtime/issues/1907)) ([1ec8203](https://github.com/netlify/next-runtime/commit/1ec820322fea66fa4027a353d5ba562074c90509))

## [4.30.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.30.2...plugin-nextjs-v4.30.3) (2023-01-30)


### Bug Fixes

* added support for "missing" matcher ([#1905](https://github.com/netlify/next-runtime/issues/1905)) ([f30e178](https://github.com/netlify/next-runtime/commit/f30e17818c3770a3fdc753ffee90f1b2502388ae))
* correctly match params in edge runtime ([#1896](https://github.com/netlify/next-runtime/issues/1896)) ([75c0535](https://github.com/netlify/next-runtime/commit/75c05352d1dc8761e065522e7266de1f193569a8))

## [4.30.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.30.1...plugin-nextjs-v4.30.2) (2023-01-24)


### Bug Fixes

* custom headers for root route when using i18n ([#1893](https://github.com/netlify/next-runtime/issues/1893)) ([9be3382](https://github.com/netlify/next-runtime/commit/9be33822017a5b8404714f96e7942e5498e47212))
* handle v1 edge function definition ([#1903](https://github.com/netlify/next-runtime/issues/1903)) ([cdcf60e](https://github.com/netlify/next-runtime/commit/cdcf60e4c0a1a52105dc11e2a5be13434a758032))

## [4.30.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.30.0...plugin-nextjs-v4.30.1) (2023-01-23)


### Bug Fixes

* added polyfill for process.env ([#1889](https://github.com/netlify/next-runtime/issues/1889)) ([15af7c7](https://github.com/netlify/next-runtime/commit/15af7c71bd25588b0aef1db7c48f271dfb7d367b))
* correctly handle ISR for appDir pages ([#1855](https://github.com/netlify/next-runtime/issues/1855)) ([f2a7cac](https://github.com/netlify/next-runtime/commit/f2a7cac3a02d469e674559a93b7544aa6f964e12))
* correctly rewrite default locale ISR homepage to ODB handler ([#1867](https://github.com/netlify/next-runtime/issues/1867)) ([14ad486](https://github.com/netlify/next-runtime/commit/14ad486c0ee90e7c06cf7b5f1c7e7ac8132ea9cc))
* getMaxAge is not used in APIHandlers ([#1888](https://github.com/netlify/next-runtime/issues/1888)) ([d0343b8](https://github.com/netlify/next-runtime/commit/d0343b83b2f06e6850d7d3771a4d78342e8b3084))
* match edge runtime pages with optional trailing slash ([#1892](https://github.com/netlify/next-runtime/issues/1892)) ([138b19d](https://github.com/netlify/next-runtime/commit/138b19d3bcafae4343e411034a94380372dee545))
* transform Regex named capture groups for Golang ([#1809](https://github.com/netlify/next-runtime/issues/1809)) ([15790aa](https://github.com/netlify/next-runtime/commit/15790aa35cee54872b1bc65e9f93e4f4bb3828d5))

## [4.30.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.29.4...plugin-nextjs-v4.30.0) (2023-01-09)


### Features

* add Next 13 request header mutation to middleware ([#1866](https://github.com/netlify/next-runtime/issues/1866)) ([5d60191](https://github.com/netlify/next-runtime/commit/5d60191905e9df8ca6cec7dc586f95917906b750))


### Bug Fixes

* **deps:** update dependency @netlify/functions to ^1.4.0 ([#1869](https://github.com/netlify/next-runtime/issues/1869)) ([3960c31](https://github.com/netlify/next-runtime/commit/3960c31f5dc9067eac347f437274f18265ffb589))
* **deps:** update dependency @netlify/ipx to ^1.3.3 ([#1868](https://github.com/netlify/next-runtime/issues/1868)) ([d75d0ff](https://github.com/netlify/next-runtime/commit/d75d0ffafdc7b7623328f5176e6d4cf45185e69e))
* merge Middleware and API route response cookies ([#1870](https://github.com/netlify/next-runtime/issues/1870)) ([878ddd7](https://github.com/netlify/next-runtime/commit/878ddd750d21632d2f4e67d2f6d7724bffcef218))
* serve static files from basePath ([#1850](https://github.com/netlify/next-runtime/issues/1850)) ([d4ff894](https://github.com/netlify/next-runtime/commit/d4ff894e88bed1138fefacb9ce2fcbe62f62f5b0))

## [4.29.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.29.3...plugin-nextjs-v4.29.4) (2022-12-19)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.3.2 ([#1833](https://github.com/netlify/next-runtime/issues/1833)) ([fb4d816](https://github.com/netlify/next-runtime/commit/fb4d816665433e7a8e2172b98d2bb37b766efc89))
* support appDir ([#1638](https://github.com/netlify/next-runtime/issues/1638)) ([a5b8047](https://github.com/netlify/next-runtime/commit/a5b80475a89f5ab2266059ad2e96c8786ff41421))
* use static 404 for non-prerendered dynamic routes without fallback ([#1795](https://github.com/netlify/next-runtime/issues/1795)) ([2aa02db](https://github.com/netlify/next-runtime/commit/2aa02dbe8140b2107c312e757e9dc1609c3b4e70))

## [4.29.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.29.2...plugin-nextjs-v4.29.3) (2022-12-05)


### Bug Fixes

* assign globals to `self` ([#1823](https://github.com/netlify/next-runtime/issues/1823)) ([993766b](https://github.com/netlify/next-runtime/commit/993766b0f9d9638c2b6ef838d76a666d38b45db7))
* better headers.getAll polyfill ([#1801](https://github.com/netlify/next-runtime/issues/1801)) ([84579c1](https://github.com/netlify/next-runtime/commit/84579c159bf111b37ef56a5db92ebff5daea5821))
* get source file for page in api routes ([#1778](https://github.com/netlify/next-runtime/issues/1778)) ([2a3ad3c](https://github.com/netlify/next-runtime/commit/2a3ad3c9a1d3e36eeaba86280f05b0ba5d8ea8a9))

## [4.29.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.29.1...plugin-nextjs-v4.29.2) (2022-11-21)


### Bug Fixes

* add longitude, latitude, and timezone to RequestData.geo ([#1777](https://github.com/netlify/next-runtime/issues/1777)) ([3f35549](https://github.com/netlify/next-runtime/commit/3f355497f02726a54aa0b5f391c3e9684d45228f))
* resolve all pages using nft ([#1780](https://github.com/netlify/next-runtime/issues/1780)) ([267ff0b](https://github.com/netlify/next-runtime/commit/267ff0b5ecf5d9fe5154955542887d9c0c573b85))

## [4.29.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.29.0...plugin-nextjs-v4.29.1) (2022-11-14)


### Bug Fixes

* exclude sourcemaps from bundle ([#1772](https://github.com/netlify/next-runtime/issues/1772)) ([4cad33e](https://github.com/netlify/next-runtime/commit/4cad33e7adef50f2d45d46a162c480f3297bc4f3))
* polyfill headers.getAll ([#1766](https://github.com/netlify/next-runtime/issues/1766)) ([b400efb](https://github.com/netlify/next-runtime/commit/b400efb895a5a9444e2d483c8e7a3dcd8bcdc5b0))
* revert publish from subdirectory ([#1771](https://github.com/netlify/next-runtime/issues/1771)) ([0554d6a](https://github.com/netlify/next-runtime/commit/0554d6a84b26a4c8465a2d42eb25ff8bb0b0a0c3))

## [4.29.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.7...plugin-nextjs-v4.29.0) (2022-11-11)


### Features

* add next debug logging ([#1761](https://github.com/netlify/next-runtime/issues/1761)) ([9607031](https://github.com/netlify/next-runtime/commit/960703136af8bcedc26345c31ca25da08366984e))

## [4.28.7](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.6...plugin-nextjs-v4.28.7) (2022-11-11)


### Bug Fixes

* publish from subdirectory ([#1756](https://github.com/netlify/next-runtime/issues/1756)) ([1faf191](https://github.com/netlify/next-runtime/commit/1faf1911f2b2fbf87bb0c75c26eba951a0ddfa3a))

## [4.28.6](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.5...plugin-nextjs-v4.28.6) (2022-11-07)


### Bug Fixes

* exclude swc by default, and don't exclude sharp if included ([#1745](https://github.com/netlify/next-runtime/issues/1745)) ([383c186](https://github.com/netlify/next-runtime/commit/383c186a988d972f84b1d04b1626f0670f71b065))

## [4.28.5](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.4...plugin-nextjs-v4.28.5) (2022-11-07)


### Bug Fixes

* resolve _app deps in API routes ([#1738](https://github.com/netlify/next-runtime/issues/1738)) ([df6fcda](https://github.com/netlify/next-runtime/commit/df6fcda60eab1b60c9cfb3710106e4bdec2ff1eb))

## [4.28.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.3...plugin-nextjs-v4.28.4) (2022-11-02)


### Bug Fixes

* only split extended routes to decrease build times ([#1731](https://github.com/netlify/next-runtime/issues/1731)) ([1e6fb8c](https://github.com/netlify/next-runtime/commit/1e6fb8cf2a1b00d57ae0a2df945514988ebb7dd3))

## [4.28.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.2...plugin-nextjs-v4.28.3) (2022-10-27)


### Bug Fixes

* disable minimal mode for API routes ([#1727](https://github.com/netlify/next-runtime/issues/1727)) ([da8f440](https://github.com/netlify/next-runtime/commit/da8f4405a1f7fd3da6789743f93400d678109022))

## [4.28.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.1...plugin-nextjs-v4.28.2) (2022-10-26)


### Bug Fixes

* follow redirects when downloading a file from the CDN ([#1719](https://github.com/netlify/next-runtime/issues/1719)) ([1d27a99](https://github.com/netlify/next-runtime/commit/1d27a993361e2b979861eee2f33229ddf83bf98c))

## [4.28.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.28.0...plugin-nextjs-v4.28.1) (2022-10-25)


### Bug Fixes

* use process.env.URL when deploying to production ([#1680](https://github.com/netlify/next-runtime/issues/1680)) ([4b08911](https://github.com/netlify/next-runtime/commit/4b08911bb0578d8c5963b7eecdaa0dac54cc7bad))

## [4.28.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.27.3...plugin-nextjs-v4.28.0) (2022-10-25)


### Features

* add support for WebAssembly in edge runtime ([#1676](https://github.com/netlify/next-runtime/issues/1676)) ([530088c](https://github.com/netlify/next-runtime/commit/530088cd0e912d6fb3682a1a7a90a1d8d4202951))
* support Next 13 ([#1714](https://github.com/netlify/next-runtime/issues/1714)) ([efcb47a](https://github.com/netlify/next-runtime/commit/efcb47a84697edd313f3d8643ebcc48f3bde11e3))

## [4.27.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.27.2...plugin-nextjs-v4.27.3) (2022-10-19)


### Bug Fixes

* correctly handle matchers with lookaheads and i18n ([#1693](https://github.com/netlify/next-runtime/issues/1693)) ([9d440ab](https://github.com/netlify/next-runtime/commit/9d440ab8ef1362c263ef7e131058c6a630945014))

## [4.27.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.27.1...plugin-nextjs-v4.27.2) (2022-10-19)


### Bug Fixes

* handle custom publish dir for api routes ([#1697](https://github.com/netlify/next-runtime/issues/1697)) ([c24a520](https://github.com/netlify/next-runtime/commit/c24a520b4ad134ba9817e0531e64ed09a3921892))

## [4.27.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.27.0...plugin-nextjs-v4.27.1) (2022-10-18)


### Bug Fixes

* gracefully handle missing static analysis tools ([#1691](https://github.com/netlify/next-runtime/issues/1691)) ([34a039e](https://github.com/netlify/next-runtime/commit/34a039ec80a7c7f050fb5f2dab6f4b8ffddda38a))

## [4.27.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.26.0...plugin-nextjs-v4.27.0) (2022-10-17)


### Features

* split api routes into separate functions ([#1495](https://github.com/netlify/next-runtime/issues/1495)) ([654c6de](https://github.com/netlify/next-runtime/commit/654c6defa99d33de5178409d43827b57a29821d8))

## [4.26.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.25.0...plugin-nextjs-v4.26.0) (2022-10-17)


### Features

* use display names for edge functions ([#1669](https://github.com/netlify/next-runtime/issues/1669)) ([310292a](https://github.com/netlify/next-runtime/commit/310292a00e2f4b8c8795a2f2093b6069dd3c78b2))


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.3.1 ([#1686](https://github.com/netlify/next-runtime/issues/1686)) ([2b419a0](https://github.com/netlify/next-runtime/commit/2b419a0573cdaf59c90cd32074ee508c5185b7d5))
* prevent Next from defining duplicate global property in edge functions ([#1682](https://github.com/netlify/next-runtime/issues/1682)) ([730df6b](https://github.com/netlify/next-runtime/commit/730df6bbfa8c697e79e1564fbeb5a53147f69505))

## [4.25.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.24.3...plugin-nextjs-v4.25.0) (2022-10-12)


### Features

* cache redirects for 60 seconds if no ttl provided ([#1677](https://github.com/netlify/next-runtime/issues/1677)) ([23d8d3b](https://github.com/netlify/next-runtime/commit/23d8d3b8fd2267053d83b4e89716ac0c2cd2ca96))

## [4.24.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.24.2...plugin-nextjs-v4.24.3) (2022-10-06)


### Bug Fixes

* remove localPrefix ([#1665](https://github.com/netlify/next-runtime/issues/1665)) ([571c0f5](https://github.com/netlify/next-runtime/commit/571c0f5254ffc62526f2a46d1d93d604bdd828b7))

## [4.24.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.24.1...plugin-nextjs-v4.24.2) (2022-10-05)


### Bug Fixes

* validate next/image params ([#1661](https://github.com/netlify/next-runtime/issues/1661)) ([c0937cf](https://github.com/netlify/next-runtime/commit/c0937cf67e84d5e14c99670910ac33fc2dd0e166))

## [4.24.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.24.0...plugin-nextjs-v4.24.1) (2022-10-05)


### Bug Fixes

* **deps:** update dependency @netlify/functions to ^1.3.0 ([#1660](https://github.com/netlify/next-runtime/issues/1660)) ([4e7e2ae](https://github.com/netlify/next-runtime/commit/4e7e2aeee431ed66d67c96115981aaafca06381a))
* set undefined ODB 404 TTLs to 60 seconds ([#1647](https://github.com/netlify/next-runtime/issues/1647)) ([029b497](https://github.com/netlify/next-runtime/commit/029b497681e4c383b182f775e772bb4602bd872a))

## [4.24.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.23.4...plugin-nextjs-v4.24.0) (2022-10-03)


### Features

* Add ability to disable ipx ([#1653](https://github.com/netlify/next-runtime/issues/1653)) ([ee7ceda](https://github.com/netlify/next-runtime/commit/ee7ceda4ba7b9822188865cac02074b034b761af))

## [4.23.4](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.23.3...plugin-nextjs-v4.23.4) (2022-10-03)


### Bug Fixes

* correctly enable edge images ([#1631](https://github.com/netlify/next-runtime/issues/1631)) ([8bcbad0](https://github.com/netlify/next-runtime/commit/8bcbad0038d85e2bf2618883b82ceb1e724e103b))

## [4.23.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.23.2...plugin-nextjs-v4.23.3) (2022-09-28)


### Bug Fixes

* add missing data to middleware request object ([#1634](https://github.com/netlify/next-runtime/issues/1634)) ([0c05726](https://github.com/netlify/next-runtime/commit/0c057265b9297ceb38d49c675159cc50b9df23a3))

## [4.23.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.23.1...plugin-nextjs-v4.23.2) (2022-09-26)


### Bug Fixes

* check NEXT_DISABLE_NETLIFY_EDGE value rather than if truthy ([#1603](https://github.com/netlify/next-runtime/issues/1603)) ([5cf8c52](https://github.com/netlify/next-runtime/commit/5cf8c52ead9a9013906201697a6a4a32fd8368f7))
* **deps:** update dependency @netlify/esbuild to v0.14.39 ([#1623](https://github.com/netlify/next-runtime/issues/1623)) ([3dc7b23](https://github.com/netlify/next-runtime/commit/3dc7b2386471b5993fe425b5d5735e945fcd9417))

## [4.23.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.23.0...plugin-nextjs-v4.23.1) (2022-09-09)


### Bug Fixes

* respect variable set in Netlify config ([#1613](https://github.com/netlify/next-runtime/issues/1613)) ([18c4663](https://github.com/netlify/next-runtime/commit/18c4663cf3b898733aea4deda0ab73f916e89e03))

## [4.23.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.22.0...plugin-nextjs-v4.23.0) (2022-09-09)


### Features

* add support for Next 12.3 middleware matchers ([#1612](https://github.com/netlify/next-runtime/issues/1612)) ([fd88b98](https://github.com/netlify/next-runtime/commit/fd88b9829f93953a06ba0d1269ac8ba5f51f6874))


### Bug Fixes

* correct handling of edge dev utils ([#1616](https://github.com/netlify/next-runtime/issues/1616)) ([62c135d](https://github.com/netlify/next-runtime/commit/62c135d8ffccc412128264124e3aa359cbb40691))
* **deps:** update dependency @netlify/ipx to ^1.2.5 ([#1615](https://github.com/netlify/next-runtime/issues/1615)) ([362d5dd](https://github.com/netlify/next-runtime/commit/362d5ddad3457e801d45406e06de6484aeccf42a))
* support non-prerendered dynamic routes with fallback false ([#1541](https://github.com/netlify/next-runtime/issues/1541)) ([92a015c](https://github.com/netlify/next-runtime/commit/92a015c28ce3df4f2c1bfbe56f766bc00c3f06f8))

## [4.22.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.21.3...plugin-nextjs-v4.22.0) (2022-09-08)


### Features

* support updated remotePatterns configuration ([#1607](https://github.com/netlify/next-runtime/issues/1607)) ([e7bed15](https://github.com/netlify/next-runtime/commit/e7bed15d6b7d2fd121b4cd6a3c9f1579b1ae90e3))

## [4.21.3](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.21.2...plugin-nextjs-v4.21.3) (2022-09-08)


### Bug Fixes

* handle stricter Next type ([#1597](https://github.com/netlify/next-runtime/issues/1597)) ([368ab3c](https://github.com/netlify/next-runtime/commit/368ab3cde9a2145144a112ca1c0459665b790321))

## [4.21.2](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.21.1...plugin-nextjs-v4.21.2) (2022-09-06)


### Bug Fixes

* clean up edge functions during build ([#1588](https://github.com/netlify/next-runtime/issues/1588)) ([ae2c103](https://github.com/netlify/next-runtime/commit/ae2c1038ea8554858da4dd91bebf1381f71b63d1))
* **deps:** update dependency @netlify/ipx to ^1.2.4 ([#1590](https://github.com/netlify/next-runtime/issues/1590)) ([70d38ca](https://github.com/netlify/next-runtime/commit/70d38cad88c8bea7c8ed7332c91018a50d64b6fb))
* watch for creation of middleware ([#1592](https://github.com/netlify/next-runtime/issues/1592)) ([3ae0ee6](https://github.com/netlify/next-runtime/commit/3ae0ee6d60667290d2fabc76b754ee2a82e1ca3e))

## [4.21.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.21.0...plugin-nextjs-v4.21.1) (2022-08-31)


### Bug Fixes

* remove Next.js as a peer dependency ([#1584](https://github.com/netlify/next-runtime/issues/1584)) ([6be4dc0](https://github.com/netlify/next-runtime/commit/6be4dc08e5339efb84e180e9ea02ce0bc6efe5b5))

## [4.21.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.20.0...plugin-nextjs-v4.21.0) (2022-08-30)


### Features

* only run next-dev middleware in dev ([#1582](https://github.com/netlify/next-runtime/issues/1582)) ([9baf979](https://github.com/netlify/next-runtime/commit/9baf979d141693b06478bc0c926f6c7e30296e73))

## [4.20.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.19.0...plugin-nextjs-v4.20.0) (2022-08-26)


### Features

* improve messaging on middleware detection ([#1575](https://github.com/netlify/next-runtime/issues/1575)) ([73d6b8e](https://github.com/netlify/next-runtime/commit/73d6b8ed0d8cffda467e335870846fc99b12e67e))

## [4.19.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.18.1...plugin-nextjs-v4.19.0) (2022-08-25)


### Features

* allows disabling function size check ([#1570](https://github.com/netlify/next-runtime/issues/1570)) ([6a046de](https://github.com/netlify/next-runtime/commit/6a046de211f6987d68e547ff70ea75a7f72b74c9))

## [4.18.1](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.18.0...plugin-nextjs-v4.18.1) (2022-08-25)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.2.3 ([#1571](https://github.com/netlify/next-runtime/issues/1571)) ([471ce8d](https://github.com/netlify/next-runtime/commit/471ce8d5a32f3a83f05844c8966644040defa101))

## [4.18.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.17.0...plugin-nextjs-v4.18.0) (2022-08-22)


### Features

* ✨  change over to next-runtime ([#1540](https://github.com/netlify/next-runtime/issues/1540)) ([7ecf41d](https://github.com/netlify/next-runtime/commit/7ecf41d1908bc1879761ce5324fe231c75673ead))
* add edge middleware support to `ntl dev` ([#1546](https://github.com/netlify/next-runtime/issues/1546)) ([b208ff4](https://github.com/netlify/next-runtime/commit/b208ff463499565d86cc15747b95895b3da18e55))
* default edge middleware to on ([#1547](https://github.com/netlify/next-runtime/issues/1547)) ([9578fa9](https://github.com/netlify/next-runtime/commit/9578fa9d924362f5479f42be287028684a35ea12))
* **graph:** populate graph token for ISR ([#1525](https://github.com/netlify/next-runtime/issues/1525)) ([573b913](https://github.com/netlify/next-runtime/commit/573b9137241882359411f448acd044a32c2c8169))
* skip run if @netlify/plugin-nextjs installed ([#1536](https://github.com/netlify/next-runtime/issues/1536)) ([0b4cf8c](https://github.com/netlify/next-runtime/commit/0b4cf8c6df7745fed91a59b90ab0e9f7f909b033))
* support custom response headers on images served via IPX ([#1515](https://github.com/netlify/next-runtime/issues/1515)) ([40cb8a9](https://github.com/netlify/next-runtime/commit/40cb8a9643794121c9253ffb48555f029c7ae9af))


### Bug Fixes

* check for middleware manifest before providing to Object.keys ([#1559](https://github.com/netlify/next-runtime/issues/1559)) ([f500f51](https://github.com/netlify/next-runtime/commit/f500f516281e3a2ebdd82cedaee91c05b0a438c0))
* **deps:** update dependency @netlify/functions to ^1.1.0 ([#1526](https://github.com/netlify/next-runtime/issues/1526)) ([8a98d72](https://github.com/netlify/next-runtime/commit/8a98d7237f9168342e3bfeb9dbcc9240d694dcdd))
* **deps:** update dependency @netlify/functions to ^1.2.0 ([#1543](https://github.com/netlify/next-runtime/issues/1543)) ([81381eb](https://github.com/netlify/next-runtime/commit/81381eb0955b7ab6db12da1c23a3f315b6754459))
* **deps:** update dependency @netlify/ipx to ^1.2.1 ([#1534](https://github.com/netlify/next-runtime/issues/1534)) ([086a703](https://github.com/netlify/next-runtime/commit/086a703c87fb196d3b84c698dfb1621be6a0713b))
* **deps:** update dependency @netlify/ipx to ^1.2.2 ([#1544](https://github.com/netlify/next-runtime/issues/1544)) ([097e624](https://github.com/netlify/next-runtime/commit/097e624261fad97da3411439f8e7c3baa0f706c1))
* ensure newly-created middleware works ([#1558](https://github.com/netlify/next-runtime/issues/1558)) ([39f3b4b](https://github.com/netlify/next-runtime/commit/39f3b4b87393bd38421bd01eca13e68a608a0f85))
* handle missing config base ([#1555](https://github.com/netlify/next-runtime/issues/1555)) ([f69d9db](https://github.com/netlify/next-runtime/commit/f69d9dbdf3d461f8ed370a9acb577fa33201f093))
* use individual next/server deno imports ([#1556](https://github.com/netlify/next-runtime/issues/1556)) ([0667662](https://github.com/netlify/next-runtime/commit/0667662bb125a06c72b399fa08b5a2e10eb89d4d))

## [4.17.0](https://github.com/netlify/next-runtime/compare/next-runtime-v4.16.0...next-runtime-v4.17.0) (2022-08-17)


### Features

* ✨  change over to next-runtime ([#1540](https://github.com/netlify/next-runtime/issues/1540)) ([7ecf41d](https://github.com/netlify/next-runtime/commit/7ecf41d1908bc1879761ce5324fe231c75673ead))
* **graph:** populate graph token for ISR ([#1525](https://github.com/netlify/next-runtime/issues/1525)) ([573b913](https://github.com/netlify/next-runtime/commit/573b9137241882359411f448acd044a32c2c8169))
* skip run if @netlify/plugin-nextjs installed ([#1536](https://github.com/netlify/next-runtime/issues/1536)) ([0b4cf8c](https://github.com/netlify/next-runtime/commit/0b4cf8c6df7745fed91a59b90ab0e9f7f909b033))
* support custom response headers on images served via IPX ([#1515](https://github.com/netlify/next-runtime/issues/1515)) ([40cb8a9](https://github.com/netlify/next-runtime/commit/40cb8a9643794121c9253ffb48555f029c7ae9af))


### Bug Fixes

* **deps:** update dependency @netlify/functions to ^1.1.0 ([#1526](https://github.com/netlify/next-runtime/issues/1526)) ([8a98d72](https://github.com/netlify/next-runtime/commit/8a98d7237f9168342e3bfeb9dbcc9240d694dcdd))
* **deps:** update dependency @netlify/functions to ^1.2.0 ([#1543](https://github.com/netlify/next-runtime/issues/1543)) ([81381eb](https://github.com/netlify/next-runtime/commit/81381eb0955b7ab6db12da1c23a3f315b6754459))
* **deps:** update dependency @netlify/ipx to ^1.2.1 ([#1534](https://github.com/netlify/next-runtime/issues/1534)) ([086a703](https://github.com/netlify/next-runtime/commit/086a703c87fb196d3b84c698dfb1621be6a0713b))
* **deps:** update dependency @netlify/ipx to ^1.2.2 ([#1544](https://github.com/netlify/next-runtime/issues/1544)) ([097e624](https://github.com/netlify/next-runtime/commit/097e624261fad97da3411439f8e7c3baa0f706c1))

## [4.16.0](https://github.com/netlify/next-runtime/compare/plugin-nextjs-v4.15.0...plugin-nextjs-v4.16.0) (2022-08-15)


### Features

* **graph:** populate graph token for ISR ([#1525](https://github.com/netlify/next-runtime/issues/1525)) ([573b913](https://github.com/netlify/next-runtime/commit/573b9137241882359411f448acd044a32c2c8169))


### Bug Fixes

* **deps:** update dependency @netlify/functions to ^1.1.0 ([#1526](https://github.com/netlify/next-runtime/issues/1526)) ([8a98d72](https://github.com/netlify/next-runtime/commit/8a98d7237f9168342e3bfeb9dbcc9240d694dcdd))
* **deps:** update dependency @netlify/ipx to ^1.2.1 ([#1534](https://github.com/netlify/next-runtime/issues/1534)) ([086a703](https://github.com/netlify/next-runtime/commit/086a703c87fb196d3b84c698dfb1621be6a0713b))

## [4.15.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.14.2...plugin-nextjs-v4.15.0) (2022-08-12)


### Features

* support custom response headers on images served via IPX ([#1515](https://github.com/netlify/netlify-plugin-nextjs/issues/1515)) ([40cb8a9](https://github.com/netlify/netlify-plugin-nextjs/commit/40cb8a9643794121c9253ffb48555f029c7ae9af))

## [4.14.2](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.14.1...plugin-nextjs-v4.14.2) (2022-08-11)


### Bug Fixes

* allow proxy of /_next/static ([#1503](https://github.com/netlify/netlify-plugin-nextjs/issues/1503)) ([4efef60](https://github.com/netlify/netlify-plugin-nextjs/commit/4efef6010600195d61aef79606c800a8b9c7c22b))
* **deps:** update dependency @netlify/ipx to ^1.1.4 ([#1512](https://github.com/netlify/netlify-plugin-nextjs/issues/1512)) ([44bdb1f](https://github.com/netlify/netlify-plugin-nextjs/commit/44bdb1fbe53fa929e270cad70e2cde5e84330baf))
* **deps:** update dependency @netlify/ipx to ^1.2.0 ([#1516](https://github.com/netlify/netlify-plugin-nextjs/issues/1516)) ([b90bf3e](https://github.com/netlify/netlify-plugin-nextjs/commit/b90bf3e6aff30dabbd5064b0553818304f92d211))

## [4.14.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.14.0...plugin-nextjs-v4.14.1) (2022-08-03)


### Bug Fixes

* replace netlify:edge identifier with full URL ([#1500](https://github.com/netlify/netlify-plugin-nextjs/issues/1500)) ([69327e6](https://github.com/netlify/netlify-plugin-nextjs/commit/69327e64f98234e3df37acc6d7479e705f5998c0))

## [4.14.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.13.1...plugin-nextjs-v4.14.0) (2022-08-01)


### Features

* add enhanced middleware support ([#1479](https://github.com/netlify/netlify-plugin-nextjs/issues/1479)) ([689b2ac](https://github.com/netlify/netlify-plugin-nextjs/commit/689b2ac055f268c99415dd8a4fe5ddd5db2d5598))

## [4.13.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.13.0...plugin-nextjs-v4.13.1) (2022-07-25)


### Bug Fixes

* update patch syntax ([#1480](https://github.com/netlify/netlify-plugin-nextjs/issues/1480)) ([11f4ef1](https://github.com/netlify/netlify-plugin-nextjs/commit/11f4ef1494c76212acf7859c112a8801aad7ad54))

## [4.13.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.12.2...plugin-nextjs-v4.13.0) (2022-07-21)


### Features

* dx updates to default demo site ([#1447](https://github.com/netlify/netlify-plugin-nextjs/issues/1447)) ([0d194fc](https://github.com/netlify/netlify-plugin-nextjs/commit/0d194fc0329fdaf2683146bf8bde474eb22a35c8))


### Bug Fixes

* add better error messaging for builds ([#1467](https://github.com/netlify/netlify-plugin-nextjs/issues/1467)) ([1d90f68](https://github.com/netlify/netlify-plugin-nextjs/commit/1d90f68d9f947dec0b104b84579be70b5056162e))

## [4.12.2](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.12.1...plugin-nextjs-v4.12.2) (2022-07-13)


### Bug Fixes

* include css files in handler functions ([#1463](https://github.com/netlify/netlify-plugin-nextjs/issues/1463)) ([ebdf991](https://github.com/netlify/netlify-plugin-nextjs/commit/ebdf9918e1dd28db504c894439625916d928c6ec))

## [4.12.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.12.0...plugin-nextjs-v4.12.1) (2022-07-12)


### Bug Fixes

* copy imageconfig into edge function dir ([#1462](https://github.com/netlify/netlify-plugin-nextjs/issues/1462)) ([58ba162](https://github.com/netlify/netlify-plugin-nextjs/commit/58ba162a9c8d02212eb044d0df9dfb3be0c11eea))

## [4.12.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.11.2...plugin-nextjs-v4.12.0) (2022-07-12)


### Features

* get client IP from Context object rather than header ([#1460](https://github.com/netlify/netlify-plugin-nextjs/issues/1460)) ([30b6717](https://github.com/netlify/netlify-plugin-nextjs/commit/30b67171421e4b801162c438d2e721d73d01a57c))

## [4.11.2](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.11.1...plugin-nextjs-v4.11.2) (2022-07-12)


### Bug Fixes

* explicitly type image config in ipx edge function ([#1457](https://github.com/netlify/netlify-plugin-nextjs/issues/1457)) ([a96af92](https://github.com/netlify/netlify-plugin-nextjs/commit/a96af9264f322bbf64c3e746a376c3287f39cce1))

## [4.11.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.11.0...plugin-nextjs-v4.11.1) (2022-06-30)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.1.3 ([#1441](https://github.com/netlify/netlify-plugin-nextjs/issues/1441)) ([9a72c0c](https://github.com/netlify/netlify-plugin-nextjs/commit/9a72c0ce7baf85bb3f5266b593162895a20ac9df))

## [4.11.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.10.1...plugin-nextjs-v4.11.0) (2022-06-30)


### Features

* use edge functions for content negotiation by default ([#1438](https://github.com/netlify/netlify-plugin-nextjs/issues/1438)) ([0bac0e0](https://github.com/netlify/netlify-plugin-nextjs/commit/0bac0e078600bf3a014b270f0d40143345a68107))

## [4.10.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.10.0...plugin-nextjs-v4.10.1) (2022-06-29)


### Bug Fixes

* check for Middleware manifest & chain ([#1435](https://github.com/netlify/netlify-plugin-nextjs/issues/1435)) ([afe65eb](https://github.com/netlify/netlify-plugin-nextjs/commit/afe65ebd3cbe1ad8dec947ae43dd9a8eb2af1d86))

## [4.10.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.9.3...plugin-nextjs-v4.10.0) (2022-06-29)


### Features

* middleware warning ([#1425](https://github.com/netlify/netlify-plugin-nextjs/issues/1425)) ([3c56eda](https://github.com/netlify/netlify-plugin-nextjs/commit/3c56eda2b4824b4d0c5785fcd508f4571b960300))

## [4.9.3](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.9.2...plugin-nextjs-v4.9.3) (2022-06-24)


### Bug Fixes

* handle missing manifest functions field ([#1416](https://github.com/netlify/netlify-plugin-nextjs/issues/1416)) ([5114193](https://github.com/netlify/netlify-plugin-nextjs/commit/5114193ac37f00a51a8637b11638857c8dfc4698))

## [4.9.2](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.9.1...plugin-nextjs-v4.9.2) (2022-06-23)


### Bug Fixes

* **deps:** upgrade ipx ([#1409](https://github.com/netlify/netlify-plugin-nextjs/issues/1409)) ([050ddcc](https://github.com/netlify/netlify-plugin-nextjs/commit/050ddcc62c6d4c145e82cc9f8516b2d9bfdff92c))

## [4.9.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.9.0...plugin-nextjs-v4.9.1) (2022-06-14)


### Bug Fixes

* check for existence of experimental images ([#1392](https://github.com/netlify/netlify-plugin-nextjs/issues/1392)) ([db004fa](https://github.com/netlify/netlify-plugin-nextjs/commit/db004fa694757006aa699e9e9181c5d2ad088969))

## [4.9.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.8.0...plugin-nextjs-v4.9.0) (2022-06-14)


### Features

* add support for experimental image remotePatterns ([#1375](https://github.com/netlify/netlify-plugin-nextjs/issues/1375)) ([9095c82](https://github.com/netlify/netlify-plugin-nextjs/commit/9095c82b95018ce82a23fe90c48c84b99750d4f9))


### Bug Fixes

* **deps:** update dependency @netlify/ipx to ^1.1.0 ([#1377](https://github.com/netlify/netlify-plugin-nextjs/issues/1377)) ([9ed5c38](https://github.com/netlify/netlify-plugin-nextjs/commit/9ed5c38c520b8d14f1c1e99f89355b308bd6c0b6))
* run edge middleware on data requests ([#1382](https://github.com/netlify/netlify-plugin-nextjs/issues/1382)) ([55755df](https://github.com/netlify/netlify-plugin-nextjs/commit/55755dfc05118e1ff044398d9227b11aeb0d8352))

## [4.8.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.7.1...plugin-nextjs-v4.8.0) (2022-06-06)


### Features

* added better custom header support ([#1358](https://github.com/netlify/netlify-plugin-nextjs/issues/1358)) ([46d8f3a](https://github.com/netlify/netlify-plugin-nextjs/commit/46d8f3ab4670768d7dd2f8c13ce68ef9d45208ae))

### [4.7.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.7.0...plugin-nextjs-v4.7.1) (2022-05-25)


### Bug Fixes

* **deps:** update dependency @netlify/ipx to v1 ([#1343](https://github.com/netlify/netlify-plugin-nextjs/issues/1343)) ([4ab9ff4](https://github.com/netlify/netlify-plugin-nextjs/commit/4ab9ff45db88b24efb062aeb1e56af8245d464f2))
* don't override user defined NEXTAUTH_URL ([#1360](https://github.com/netlify/netlify-plugin-nextjs/issues/1360)) ([9010da3](https://github.com/netlify/netlify-plugin-nextjs/commit/9010da3d2f5da98c040beba9634651499e65cf88))

## [4.7.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.6.0...plugin-nextjs-v4.7.0) (2022-05-02)


### Features

* Include basePath property in NEXTAUTH_URL when present in config ([#1336](https://github.com/netlify/netlify-plugin-nextjs/issues/1336)) ([346aad1](https://github.com/netlify/netlify-plugin-nextjs/commit/346aad1a46e0e774b68d0436a193909689a6eb49))

## [4.6.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.5.0...plugin-nextjs-v4.6.0) (2022-04-28)


### Features

* Add support for next-i18next ([#1331](https://github.com/netlify/netlify-plugin-nextjs/issues/1331)) ([5780e6b](https://github.com/netlify/netlify-plugin-nextjs/commit/5780e6b5710ca84c75a272d00fa43a3ad3b87289))

## [4.5.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.4.4...plugin-nextjs-v4.5.0) (2022-04-26)


### Features

* ✨ add out-of-the-box support for NextAuth.js   ([#1309](https://github.com/netlify/netlify-plugin-nextjs/issues/1309)) ([45c0978](https://github.com/netlify/netlify-plugin-nextjs/commit/45c0978dcad92b6ba028850598425875d09fcf32))

### [4.4.4](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.4.3...plugin-nextjs-v4.4.4) (2022-04-26)


### Bug Fixes

* handle absolute rewrite URLs ([#1325](https://github.com/netlify/netlify-plugin-nextjs/issues/1325)) ([f8f8e85](https://github.com/netlify/netlify-plugin-nextjs/commit/f8f8e850e43ee6fc154eba3e224ddf606e721a6d))

### [4.4.3](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.4.2...plugin-nextjs-v4.4.3) (2022-04-25)


### Bug Fixes

* pass x-middleware-rewrite header to client ([#1322](https://github.com/netlify/netlify-plugin-nextjs/issues/1322)) ([ed17658](https://github.com/netlify/netlify-plugin-nextjs/commit/ed176586916aef892d3c126e10ac0e0b97875510))

### [4.4.2](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.4.1...plugin-nextjs-v4.4.2) (2022-04-19)


### Bug Fixes

* include edge templates in the bundle ([#1317](https://github.com/netlify/netlify-plugin-nextjs/issues/1317)) ([b9d3abf](https://github.com/netlify/netlify-plugin-nextjs/commit/b9d3abf6f8e99cb01856b4a3fadb7387e67164db))

### [4.4.1](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.4.0...plugin-nextjs-v4.4.1) (2022-04-19)


### Bug Fixes

* copy edge src file  ([#1315](https://github.com/netlify/netlify-plugin-nextjs/issues/1315)) ([ccdb544](https://github.com/netlify/netlify-plugin-nextjs/commit/ccdb54477a2836a433f10d7eabbb8bb3553a18d7))

## [4.4.0](https://github.com/netlify/netlify-plugin-nextjs/compare/plugin-nextjs-v4.3.2...plugin-nextjs-v4.4.0) (2022-04-19)

### Features

- add support for Edge Functions ([#1310](https://github.com/netlify/netlify-plugin-nextjs/issues/1310))
  ([d39ce27](https://github.com/netlify/netlify-plugin-nextjs/commit/d39ce2720a3a8fe766ba22654d52807ea7b4e170))

# Changelog

### [4.3.2](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.3.1...v4.3.2) (2022-04-04)

### Bug Fixes

- :bug: include terser bundle into netlify functions
  ([#1295](https://github.com/netlify/netlify-plugin-nextjs/issues/1295))
  ([f29adf3](https://github.com/netlify/netlify-plugin-nextjs/commit/f29adf3ee1d4be8bf40e4695ca4ac1e970c9b1ad))

### [4.3.1](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.3.0...v4.3.1) (2022-03-28)

### Bug Fixes

- correctly find site root when using SSR with Nx
  ([#1281](https://github.com/netlify/netlify-plugin-nextjs/issues/1281))
  ([3b26573](https://github.com/netlify/netlify-plugin-nextjs/commit/3b26573407c44a3f6405db776d9d37d993761c1c))

## [4.3.0](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.8...v4.3.0) (2022-03-23)

### Features

- allow skipping of middleware handling ([#1277](https://github.com/netlify/netlify-plugin-nextjs/issues/1277))
  ([63070da](https://github.com/netlify/netlify-plugin-nextjs/commit/63070daaff4082a756af881a382c238c37d07aec))

### Bug Fixes

- **deps:** update dependency @vercel/node-bridge to v2.2.0
  ([#1246](https://github.com/netlify/netlify-plugin-nextjs/issues/1246))
  ([3637fff](https://github.com/netlify/netlify-plugin-nextjs/commit/3637fffce8550b012c8c9f35a0b9f3d1672e90a2))

### [4.2.8](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.7...v4.2.8) (2022-03-21)

### Bug Fixes

- add new /trace to HIDDEN_PATHS ([#1259](https://github.com/netlify/netlify-plugin-nextjs/issues/1259))
  ([84345a8](https://github.com/netlify/netlify-plugin-nextjs/commit/84345a8c27f12bf1a07d1fc83cff9b9a398ee9db))
- chdir to site root ([#1265](https://github.com/netlify/netlify-plugin-nextjs/issues/1265))
  ([8463bbc](https://github.com/netlify/netlify-plugin-nextjs/commit/8463bbcff483ddb6b14e73c6959092e2938cdef1))
- **deps:** update dependency @netlify/ipx to ^0.0.10
  ([#1237](https://github.com/netlify/netlify-plugin-nextjs/issues/1237))
  ([16e067d](https://github.com/netlify/netlify-plugin-nextjs/commit/16e067d7ef16da0479d83d09b188838e66946c34))
- use correct publishDir when building from CLI with cwd option
  ([#1264](https://github.com/netlify/netlify-plugin-nextjs/issues/1264))
  ([e441c97](https://github.com/netlify/netlify-plugin-nextjs/commit/e441c970f3c7ce5c6e74a23cf55efe71d94c9027))

### [4.2.7](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.6...v4.2.7) (2022-02-18)

### Bug Fixes

- correctly cache when using `next export` ([#1223](https://github.com/netlify/netlify-plugin-nextjs/issues/1223))
  ([a8030ca](https://github.com/netlify/netlify-plugin-nextjs/commit/a8030caee02f464dd2b962d2c12318f185260af9))
- **deps:** update dependency @netlify/functions to ^0.11.1
  ([#1217](https://github.com/netlify/netlify-plugin-nextjs/issues/1217))
  ([e17892b](https://github.com/netlify/netlify-plugin-nextjs/commit/e17892bf1be7aa75822c6295955dbd250cb14197))
- **deps:** update dependency @netlify/functions to v1
  ([#1219](https://github.com/netlify/netlify-plugin-nextjs/issues/1219))
  ([af841cd](https://github.com/netlify/netlify-plugin-nextjs/commit/af841cd6d22a26d67d2d6f5328d6825c68dd22f5))

### [4.2.6](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.5...v4.2.6) (2022-02-14)

### Bug Fixes

- prepend basePath to static file URLs ([#1213](https://github.com/netlify/netlify-plugin-nextjs/issues/1213))
  ([8236b38](https://github.com/netlify/netlify-plugin-nextjs/commit/8236b38a5595abd38eec33fbe0a3aa112ded19d9))

### [4.2.5](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.4...v4.2.5) (2022-02-07)

### Bug Fixes

- remove confusing error log ([#1199](https://github.com/netlify/netlify-plugin-nextjs/issues/1199))
  ([7974849](https://github.com/netlify/netlify-plugin-nextjs/commit/7974849396a342614119cbe77e8933fdc826151e))

### [4.2.4](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.3...v4.2.4) (2022-02-03)

### Bug Fixes

- correctly disable ISR disk flushing ([#1190](https://github.com/netlify/netlify-plugin-nextjs/issues/1190))
  ([e8067bf](https://github.com/netlify/netlify-plugin-nextjs/commit/e8067bf13ec94fac80ca6ce495a32249dcd5130c))

### [4.2.3](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.2...v4.2.3) (2022-02-02)

### Bug Fixes

- don't use ODB for routes that match middleware ([#1171](https://github.com/netlify/netlify-plugin-nextjs/issues/1171))
  ([bbcdfbd](https://github.com/netlify/netlify-plugin-nextjs/commit/bbcdfbdf4062a044e6e87429119ee4ba3ac19bc0))

### [4.2.2](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.1...v4.2.2) (2022-01-31)

### Bug Fixes

- **deps:** update dependency @netlify/ipx to ^0.0.9
  ([#1181](https://github.com/netlify/netlify-plugin-nextjs/issues/1181))
  ([2e55a9e](https://github.com/netlify/netlify-plugin-nextjs/commit/2e55a9efc2c0d7ccffe3757c7ef915219b1598e8))

### [4.2.1](https://github.com/netlify/netlify-plugin-nextjs/compare/v4.2.0...v4.2.1) (2022-01-24)

### Bug Fixes

- **deps:** update dependency @netlify/functions to ^0.11.0
  ([#1146](https://github.com/netlify/netlify-plugin-nextjs/issues/1146))
  ([4da630b](https://github.com/netlify/netlify-plugin-nextjs/commit/4da630bc6596f790cb45ea0a4cd82d235ff1d3b1))
- **deps:** update dependency core-js to v3.20.3 ([#1155](https://github.com/netlify/netlify-plugin-nextjs/issues/1155))
  ([043ad36](https://github.com/netlify/netlify-plugin-nextjs/commit/043ad36e18cc720c48dc4a5c29659c79a8982abb))
- provide hostname and port to server ([#1149](https://github.com/netlify/netlify-plugin-nextjs/issues/1149))
  ([02053fd](https://github.com/netlify/netlify-plugin-nextjs/commit/02053fdce786e26a5a6c60a9e38b9e05fd2ac0d3))

## [4.2.0](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.1.3...v4.2.0) (2022-01-17)

### Features

- add request logging ([#1127](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1127))
  ([010e86c](https://www.github.com/netlify/netlify-plugin-nextjs/commit/010e86c7c7513df8676dd8b3c747dcfa81fbc09e))

### [4.1.3](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.1.2...v4.1.3) (2022-01-13)

### Bug Fixes

- handle `routes-manifest`s without `staticRoutes` defined
  ([#1120](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1120))
  ([96f3ccb](https://www.github.com/netlify/netlify-plugin-nextjs/commit/96f3ccb977e66dcd2b1a7911df24357501d18435))

### [4.1.2](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.1.1...v4.1.2) (2022-01-11)

### Bug Fixes

- add specific rewrites for all SSR routes ([#1105](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1105))
  ([6fd7bcc](https://www.github.com/netlify/netlify-plugin-nextjs/commit/6fd7bcc99aacf447559de46f60de6d8cb33e7a59))
- **deps:** update dependency core-js to v3.20.2
  ([#1095](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1095))
  ([41966ca](https://www.github.com/netlify/netlify-plugin-nextjs/commit/41966cac3b17035f6b008ddbf66ad1b3e6920e07))

### [4.1.1](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.1.0...v4.1.1) (2021-12-21)

### Bug Fixes

- fix bug that caused ISR pages to sometimes serve first built version
  ([#1051](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1051))
  ([62660b2](https://www.github.com/netlify/netlify-plugin-nextjs/commit/62660b2da56457a5993985b05a7cdfd73e698bba))
- force React to use production env ([#1056](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1056))
  ([eca0bee](https://www.github.com/netlify/netlify-plugin-nextjs/commit/eca0bee044ae44193eae7c9864153ae9b627b0ac))

## [4.1.0](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0...v4.1.0) (2021-12-17)

### Features

- add support for use with `next export` ([#1012](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1012))
  ([76edc53](https://www.github.com/netlify/netlify-plugin-nextjs/commit/76edc5324d89adfad8c43a654ecec7719861e2b4))

### Bug Fixes

- prevent infinite loop when `/` is ISR ([#1020](https://www.github.com/netlify/netlify-plugin-nextjs/issues/1020))
  ([55b18e6](https://www.github.com/netlify/netlify-plugin-nextjs/commit/55b18e6e4ea9424e896b860502d645513112c4f3))

## [4.0.0](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-rc.2...v4.0.0) (2021-12-14)

This is a full rewrite of the Essential Next.js plugin, with a new architecture that gives greater compatibility and
stability.

### What's new

- Full support for
  [incremental static regeneration (ISR)](https://github.com/netlify/netlify-plugin-nextjs/blob/main/docs/isr.md).
- Full support for
  [Next.js rewrites, redirects and headers](https://github.com/netlify/netlify-plugin-nextjs/blob/main/docs/redirects-rewrites.md).
- Beta support for [Next 12 Middleware](https://github.com/netlify/netlify-plugin-nextjs/blob/main/docs/middleware.md)
- Faster builds and deploys. Instead of generating one function per route, there are just three functions per site and a
  much smaller list of rewrites.
- Full support for Netlify's new [persistent On-Demand Builders](https://ntl.fyi/odb). Return `fallback: "blocking"`
  from `getStaticPaths` and your rendering will be deferred until the first page load, then persisted globally.
- A new image server for next/image, built on Nuxt's [ipx](https://github.com/unjs/ipx/). This is a high-performance,
  framework-agnostic image server based on sharp. This implementation uses On-Demand Builders to persist transformed
  images globally. Improved source image caching reduces time-to-first-byte for new transforms.
- Simplified configuration. You no longer need to set any Netlify-specific configuration options. For example, in a
  monorepo all you need to do is set `publish` to point to your `.next` directory and you can build the site in any way
  you like.
- Removes requirement for the `target` to be set to `serverless`, which is deprecated in Next 12.
- Bundling now uses Next.js's own node-file-trace, giving more predictable results and smaller uploads.

### Breaking changes

The `publish` directory should point to the site's `.next` directory or `distDir` if set, rather than `out` as in
previous versions of the plugin.

### Migration guide

Change the `publish` directory to `.next`:

```toml
[build]
publish = ".next"

```

If you previously set these values, they're no longer needed and can be removed:

- `target: "serverless"` in your `next.config.js`
- `distDir` in your `next.config.js`
- `node_bundler = "esbuild"` in `netlify.toml`
- `external_node_modules` in `netlify.toml`

If you currently use redirects or rewrites on your site, see
[the Rewrites and Redirects guide](https://github.com/netlify/netlify-plugin-nextjs/blob/main/docs/redirects-rewrites.md)
for information on changes to how they are handled in this version.

If you want to use Next 12's beta Middleware feature, this will mostly work as expected but please
[read the docs on some caveats and workarounds](https://github.com/netlify/netlify-plugin-nextjs/blob/main/docs/middleware.md)
that are currently needed.

## [4.0.0-rc.1](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-rc.0...v4.0.0-rc.1) (2021-12-07)

### Features

- enable TTL for all sites ([#916](https://www.github.com/netlify/netlify-plugin-nextjs/issues/916))
  ([152cf03](https://www.github.com/netlify/netlify-plugin-nextjs/commit/152cf03b29fe794322f52e0cb4afba79c0b70da5))

### Bug Fixes

- bypass preview for static files ([#918](https://www.github.com/netlify/netlify-plugin-nextjs/issues/918))
  ([ecb3cc8](https://www.github.com/netlify/netlify-plugin-nextjs/commit/ecb3cc8491a6f24f75d8072f0a5e4a49b466146a))
- work around a bug that caused a full response to be sent for images, even if the etag matched
- **deps:** update dependency @netlify/ipx to ^0.0.8
  ([#902](https://www.github.com/netlify/netlify-plugin-nextjs/issues/902))
  ([25f375f](https://www.github.com/netlify/netlify-plugin-nextjs/commit/25f375fdff074e6aabd6a6d5b66433891f8af9dc))

## [4.0.0-rc.0](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.13...v4.0.0-rc.0) (2021-12-06)

### Bug Fixes

- copy public directory output instead of input when using Nx
  ([#856](https://www.github.com/netlify/netlify-plugin-nextjs/issues/856))
  ([d959f82](https://www.github.com/netlify/netlify-plugin-nextjs/commit/d959f82e622dfb2c9e2b7139ff39e8e7eed35f5c))
- correct root redirect when trailingSlash = false
  ([#879](https://www.github.com/netlify/netlify-plugin-nextjs/issues/879))
  ([3c6b10b](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3c6b10bd38abae9a7b4e952ef9e88c254acef701))

## [4.0.0-beta.13](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.12...v4.0.0-beta.13) (2021-12-02)

### Bug Fixes

- correct handling of data route JSON files ([#864](https://www.github.com/netlify/netlify-plugin-nextjs/issues/864))
  ([adea889](https://www.github.com/netlify/netlify-plugin-nextjs/commit/adea889085be758a47a01503b0501569ee27bc6a))
- move locale detection to netlify redirects ([#861](https://www.github.com/netlify/netlify-plugin-nextjs/issues/861))
  ([964637b](https://www.github.com/netlify/netlify-plugin-nextjs/commit/964637beb6e71ecac750f84858676cd4d980c5b8))

## [4.0.0-beta.12](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.11...v4.0.0-beta.12) (2021-11-30)

### Features

- add experimental support for TTL ([#833](https://www.github.com/netlify/netlify-plugin-nextjs/issues/833))
  ([14ca14a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/14ca14a9fabc7a1fc3574e9cd9b53529f19a44c6))
- add support for Next env vars ([#842](https://www.github.com/netlify/netlify-plugin-nextjs/issues/842))
  ([24fd88a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/24fd88a843767a7df9633f6c18d7ee7fc9724279))

### Miscellaneous Chores

- **deps:** update dependency @netlify/build to v19
  ([#840](https://www.github.com/netlify/netlify-plugin-nextjs/issues/840))
  ([d927524](https://www.github.com/netlify/netlify-plugin-nextjs/commit/d927524219941fea3206abb15b2d26d6325d2921))

## [4.0.0-beta.11](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.10...v4.0.0-beta.11) (2021-11-24)

### Bug Fixes

- handle missing i18n object ([#837](https://www.github.com/netlify/netlify-plugin-nextjs/issues/837))
  ([3b6d293](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3b6d2938f0893fd4376a3f918d6f3ff81c720248))

## [4.0.0-beta.10](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.9...v4.0.0-beta.10) (2021-11-24)

### Bug Fixes

- replace node-fetch with builtin ([#834](https://www.github.com/netlify/netlify-plugin-nextjs/issues/834))
  ([6ff3100](https://www.github.com/netlify/netlify-plugin-nextjs/commit/6ff31005e87262a26c47e3fe1d6fe14d990e5554))
- correct redirect priority and correctly handle ISR pages assets
  ([#826](https://www.github.com/netlify/netlify-plugin-nextjs/issues/826))
  ([6b61643](https://www.github.com/netlify/netlify-plugin-nextjs/commit/6b61643a7d8b3f5a7c10642d250a665dfc25037c))
- **deps:** update dependency @netlify/functions to ^0.10.0
  ([#830](https://www.github.com/netlify/netlify-plugin-nextjs/issues/830))
  ([3256839](https://www.github.com/netlify/netlify-plugin-nextjs/commit/32568394b2022edc14911809ebbfbff81ac26da6))
- don't move files to the CDN if they match redirect/rewrite rules
  ([#832](https://www.github.com/netlify/netlify-plugin-nextjs/issues/832))
  ([9e3dd0e](https://www.github.com/netlify/netlify-plugin-nextjs/commit/9e3dd0ea359ccaa17ed72644faa80aefd1cf9835))

## [4.0.0-beta.9](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.8...v4.0.0-beta.9) (2021-11-19)

### Bug Fixes

- gracefully handle mssing middleware ([#821](https://www.github.com/netlify/netlify-plugin-nextjs/issues/821))
  ([4cee35d](https://www.github.com/netlify/netlify-plugin-nextjs/commit/4cee35d62c918fb6f893d740bc0c382028b43965))

## [4.0.0-beta.8](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.7...v4.0.0-beta.8) (2021-11-19)

### Features

- don't move files to CDN if they match middleware
  ([#812](https://www.github.com/netlify/netlify-plugin-nextjs/issues/812))
  ([615c97a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/615c97ab63350430d520845567a5235a40512873))
- move static pages by default ([#816](https://www.github.com/netlify/netlify-plugin-nextjs/issues/816))
  ([12ce69e](https://www.github.com/netlify/netlify-plugin-nextjs/commit/12ce69ef817c8125e82f367993b62c3631af2e30))

## [4.0.0-beta.7](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.6...v4.0.0-beta.7) (2021-11-17)

### Features

- add docs on middleware ([#795](https://www.github.com/netlify/netlify-plugin-nextjs/issues/795))
  ([3b4a8c4](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3b4a8c40e6300c0104c557bf7379859afe2be682))
- log warning if old functions exist ([#801](https://www.github.com/netlify/netlify-plugin-nextjs/issues/801))
  ([01faf58](https://www.github.com/netlify/netlify-plugin-nextjs/commit/01faf5853cd5e536b7549e627e2e65bcd6c4018f))

### Bug Fixes

- **deps:** update dependency @netlify/functions to ^0.9.0
  ([#807](https://www.github.com/netlify/netlify-plugin-nextjs/issues/807))
  ([3deec1d](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3deec1d7f32e1b77b0812b8f1e6da30976e5448c))
- ensure path is encoded ([#800](https://www.github.com/netlify/netlify-plugin-nextjs/issues/800))
  ([b0f666e](https://www.github.com/netlify/netlify-plugin-nextjs/commit/b0f666ee8aad046503f0d562d0c3e4ac4275b945))
- use forced catchall for preview mode ([#793](https://www.github.com/netlify/netlify-plugin-nextjs/issues/793))
  ([fd7130f](https://www.github.com/netlify/netlify-plugin-nextjs/commit/fd7130f4a15f51e0785cdd9515faeb10cffb67a5))

### Miscellaneous Chores

- add docs on rewrites and redirects ([#767](https://www.github.com/netlify/netlify-plugin-nextjs/issues/767))
  ([b32a08c](https://www.github.com/netlify/netlify-plugin-nextjs/commit/b32a08c01a8e440d2c5a570c50128fdc37cf89a8))

## [4.0.0-beta.6](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.5...v4.0.0-beta.6) (2021-11-08)

### Bug Fixes

- handle static file glob on Windows ([#778](https://www.github.com/netlify/netlify-plugin-nextjs/issues/778))
  ([1cc222a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/1cc222a866c2bb410965a2867984005737792fb3))
- use glob to select files to move ([#768](https://www.github.com/netlify/netlify-plugin-nextjs/issues/768))
  ([faeb703](https://www.github.com/netlify/netlify-plugin-nextjs/commit/faeb7033296a43cee7a4494298d0df4f7e78bbd3))

## [4.0.0-beta.5](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.4...v4.0.0-beta.5) (2021-11-03)

### Bug Fixes

- add missing middleware runtime file ([#762](https://www.github.com/netlify/netlify-plugin-nextjs/issues/762))
  ([83378b4](https://www.github.com/netlify/netlify-plugin-nextjs/commit/83378b4f53467284016c2ca7b3b121ca0079a1cc))
- **deps:** update dependency node-fetch to v2.6.6
  ([#758](https://www.github.com/netlify/netlify-plugin-nextjs/issues/758))
  ([759915b](https://www.github.com/netlify/netlify-plugin-nextjs/commit/759915bf98f6963cbf35619c28a719fecdd50ea7))
- don't force rewrite in preview mode ([#761](https://www.github.com/netlify/netlify-plugin-nextjs/issues/761))
  ([c88a504](https://www.github.com/netlify/netlify-plugin-nextjs/commit/c88a504e36883a644516e6b7afc8bbce00a68858))

## [4.0.0-beta.4](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.3...v4.0.0-beta.4) (2021-10-27)

### Bug Fixes

- correctly resolve zip path ([#744](https://www.github.com/netlify/netlify-plugin-nextjs/issues/744))
  ([68b5662](https://www.github.com/netlify/netlify-plugin-nextjs/commit/68b56620946364f8bd9b90896c1a9c0cba78d7a7))
- **deps:** update dependency @netlify/functions to ^0.8.0
  ([#747](https://www.github.com/netlify/netlify-plugin-nextjs/issues/747))
  ([2c87e30](https://www.github.com/netlify/netlify-plugin-nextjs/commit/2c87e307568a6547432bf6995b9427077561c74b))
- exclude electron by default ([#746](https://www.github.com/netlify/netlify-plugin-nextjs/issues/746))
  ([887b90a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/887b90a8f6cc63f3e44c6bc85888eb4d609d9ee4))

## [4.0.0-beta.3](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.2...v4.0.0-beta.3) (2021-10-26)

### Features

- support moving static pages out of function bundle
  ([#728](https://www.github.com/netlify/netlify-plugin-nextjs/issues/728))
  ([3da9c77](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3da9c77d8a021c30253c42eeab69c8feed5e79f5))
- warn if zip is too large, and log the largest files
  ([#730](https://www.github.com/netlify/netlify-plugin-nextjs/issues/730))
  ([9989c0a](https://www.github.com/netlify/netlify-plugin-nextjs/commit/9989c0a46decc3370b7fb102774360e3268f571f))

### Bug Fixes

- disable serverless targets ([#739](https://www.github.com/netlify/netlify-plugin-nextjs/issues/739))
  ([01fa113](https://www.github.com/netlify/netlify-plugin-nextjs/commit/01fa113664333db182424607ff4c2172d6fcfd59))
- ensure stale-while-revalidate headers are not sent
  ([#737](https://www.github.com/netlify/netlify-plugin-nextjs/issues/737))
  ([ef2da0d](https://www.github.com/netlify/netlify-plugin-nextjs/commit/ef2da0d8355fa7b60c1f451f19af7d2eb61ee326))
- typo in readme ([#731](https://www.github.com/netlify/netlify-plugin-nextjs/issues/731))
  ([bfc016f](https://www.github.com/netlify/netlify-plugin-nextjs/commit/bfc016f222d7e3e778fc20efa63d0e33dcc011e9))
- use nft for ipx bundle ([#725](https://www.github.com/netlify/netlify-plugin-nextjs/issues/725))
  ([0321f68](https://www.github.com/netlify/netlify-plugin-nextjs/commit/0321f68c301cae351704d0180dc17201141ddc94))
- use platform-agnostic paths, and add test to be sure
  ([#736](https://www.github.com/netlify/netlify-plugin-nextjs/issues/736))
  ([d448b11](https://www.github.com/netlify/netlify-plugin-nextjs/commit/d448b11d3d1730524c9d11ec749d2970f09ba7ea))

## [4.0.0-beta.2](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.1...v4.0.0-beta.2) (2021-10-19)

### Features

- Enable persistent builders by default ([#716](https://www.github.com/netlify/netlify-plugin-nextjs/issues/716))
  ([de07dc2](https://www.github.com/netlify/netlify-plugin-nextjs/commit/de07dc2e21c40feced296b4acb1bf2b03fe97485))

### Bug Fixes

- correctly exclude files ([#720](https://www.github.com/netlify/netlify-plugin-nextjs/issues/720))
  ([efba43e](https://www.github.com/netlify/netlify-plugin-nextjs/commit/efba43ec687f01094eb31af0b2baab36bee59ffc))
- pass query string to handler ([#719](https://www.github.com/netlify/netlify-plugin-nextjs/issues/719))
  ([ff09cae](https://www.github.com/netlify/netlify-plugin-nextjs/commit/ff09cae3940e6b3c16c0ce718664051f2c6d9537))

## [4.0.0-beta.1](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v4.0.0-beta.0...v4.0.0-beta.1) (2021-10-15)

### Bug Fixes

- pass correct path to odb ([#702](https://www.github.com/netlify/netlify-plugin-nextjs/issues/702))
  ([7c5a8ae](https://www.github.com/netlify/netlify-plugin-nextjs/commit/7c5a8ae9def9d23a6e9a05a8f52ef22181dd7572))

### Miscellaneous Chores

- update min build version ([#704](https://www.github.com/netlify/netlify-plugin-nextjs/issues/704))
  ([3e1930f](https://www.github.com/netlify/netlify-plugin-nextjs/commit/3e1930f5ea62a7332bdace7e9a95b68dc32ab954))

## [4.0.0-beta.0](https://www.github.com/netlify/netlify-plugin-nextjs/compare/v3.9.1...v4.0.0-beta.0) (2021-10-15)

A complete rewrite of the Essential Next plugin. See the README for details and migration instructions
