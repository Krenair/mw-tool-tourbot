[![Build Status](https://travis-ci.org/Krinkle/mw-tool-tourbot.svg?branch=master)](https://travis-ci.org/Krinkle/mw-tool-tourbot)

# mw-tool-tourbot

## Usage

<img height="327" alt="Screen shot" src="https://cloud.githubusercontent.com/assets/156867/24174412/b148335c-0e4d-11e7-9ef4-ada243de1fe7.png">
<img height="298" alt="" src="https://user-images.githubusercontent.com/156867/51370710-d4e53900-1aac-11e9-9359-6f5f0af7671e.png">
<img height="122" alt="" src="https://cloud.githubusercontent.com/assets/156867/24174411/b14480c2-0e4d-11e7-8fcb-1c794d22f310.png">
<img height="140" alt="" src="https://cloud.githubusercontent.com/assets/156867/16357410/220259be-3af6-11e6-9479-c4205972e3bf.png">

## Quick start

Install the [npm](https://npmjs.org/) package:

```
npm install -g mw-tool-tourbot
```

To start the interactive process, run the `tourbot` program.
Pass parameters like `tourbot --file path/to/results.txt`.

### Options

* `--file FILE`: File that contains a list of pages to process. Default: results.txt
* `--all: `Enable interactive mode for all page names, even without matches.
* `--contains TEXT`: Limit the `all` iteration to pages that currently contain the given text.
* `--match TEXT`: Similar to the `contains` parameter, but interpreted as a regular expression.
* `--auto`: Enable remembering of decisions and re-apply them automatically to similar diffs. Default: off.
* `--quick-skip`: Skip files with script errors without an interactive prompt. Default: off.
* `--help`: Show the help page, instead of running the tourbot.

### Example

The input file must contain pairs of (wiki dbname, page name) in the same format as used by `mwgrep`.

[Public results](https://gist.github.com/Krinkle/a18e726fc3af30f30bf9b2ba919820b5).

```
$ curl -O -L 'https://gist.githubusercontent.com/Krinkle/a18e726fc3af30f30bf9b2ba919820b5/raw/b32b7c3fd646f0ef3f1ba865f1c342d23195c5f5/mwgrep.mwCustomEditButtons.txt -a -c 'mwCustomEditButtons'

$ tourbot -f mwgrep.mwCustomEditButtons.txt

 Reading /Users/krinkle/Downloads/mwgrep.mwCustomEditButtons.txt

 [..]
```

### Development

Install from Git:

```
git clone https://github.com/Krinkle/mw-tool-tourbot.git
````

Manually run `npm install`. To start the interactive process, run `./bin/tourbot.js`.
Pass parameters like `./bin/tourbot.js -- --file path/to/results.txt`.

Alternatively, run `npm link` to create a global symlink for `tourbot`.

### See also
* https://github.com/he7d3r/mw-gadget-jsUpdater
