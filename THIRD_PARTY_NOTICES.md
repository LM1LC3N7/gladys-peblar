# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

Its Peblar client (`src/peblar/client.js`, the paths and fields of
`src/constants.js`) is a JavaScript port of parts of **peblar** 2.1.0
(<https://github.com/frenck/python-peblar>, tag `v2.1.0`, commit `e2cac48`),
the Python library of Home Assistant's Peblar integration: the local REST API
and web interface API paths, the login, the API token, and the models of the
meter, the EV interface, the system, the health, the user configuration and
the system information. No Python code runs here and peblar is not a
dependency. Its license:

```
MIT License

Copyright (c) 2023-2026 Franck Nijhof

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The test fixtures (`test/fixtures/fakePeblar.js`) are shaped like the
fixtures of peblar's tests; their values are made up.

Peblar is a trademark of its owner. This project is not affiliated with,
endorsed by or supported by Peblar.
