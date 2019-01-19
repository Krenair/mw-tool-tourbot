var fs = require('fs');
var path = require('path');
var URL = require('url').URL;
var colors = require('colors/safe');
var minimist = require('minimist');
var MwClient = require('nodemw');
var opener = require('opener');

var auth = require('./auth');
var ask = require('./ask');
var DecisionStore = require('./store').DecisionStore;
var Content = require('./content');
var Diff = require('./diff');
var Fixer = require('./fixer');
var replace = require('./replace');
var { SkipFileError, SkipPatternError, AbortError } = require('./error');
var patterns = require('./patterns');
var argv = minimist(process.argv.slice(2), {
  string: ['file', 'contains', 'match'],
  boolean: ['all', 'auto', 'verbose', 'quickSkip', 'help'],
  default: {
    file: 'results.txt',
    contains: null,
    match: null,
    all: false,
    auto: false,
    xt: 3,
    verbose: false,
    quickSkip: false,
    help: false
  },
  alias: {
    f: 'file',
    c: 'contains',
    m: 'match',
    a: 'all',
    x: 'auto',
    v: 'verbose',
    'quick-skip': 'quickSkip',
    h: 'help'
  }
});
var bots = Object.create(null);
var dMap = null;
var getPageCache = { title: null, promise: null };
var decisionCache;

function parseResults (results) {
  var lines = results.trim().split('\n');
  return lines.reduce(function (subjects, line) {
    var text = line.trim();
    // Filter empty lines and comments
    if (text && text[0] !== '#') {
      var parts = line.split(/\s+/);
      subjects.push({
        wikiId: parts[0],
        // Page names may contain spaces
        pageName: parts.slice(1).join(' ')
      });
    }
    return subjects;
  }, []);
}

function enhanceMwClient (client) {
  // Added method
  client.getPage = function (title) {
    var params = {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content|timestamp',
      titles: title,
      formatversion: '2'
    };
    return new Promise((resolve, reject) => {
      this.api.call(params, function (err, data) {
        if (err) {
          reject(err);
          return;
        }
        var page = data.pages[0];
        if (page.missing) {
          reject(new SkipFileError('Page [[' + title + ']] is missing'));
          return;
        }
        var revision = page.revisions && page.revisions[0];
        var resp = {
          title: page.title,
          revision: {
            timestamp: revision.timestamp,
            content: revision.content
          }
        };

        resolve(resp);
      });
    });
  };
  // Replaced method (must be backward-compatible)
  client.edit = function (pageData, content, summary, minor, callback) {
    var params = {
      text: content,
      // Avoid accidentally editing as anonymous user if session expires
      assert: 'user'
    };

    if (typeof minor === 'function') {
      callback = minor;
      minor = undefined;
    }

    if (minor) {
      params.minor = '';
    } else {
      params.notminor = '';
    }

    var title;
    if (typeof pageData === 'object') {
      params.basetimestamp = pageData.revision.timestamp;
      params.starttimestamp = new Date().toISOString();
      // Avoid accidentally creating a new page (e.g. if title string got corrupted,
      // or if page was deleted meanwhile).
      params.nocreate = '';
      title = pageData.title;
    } else {
      title = pageData;
    }

    this.doEdit('edit', title, summary, params, callback);
  };

  // Cached and promisified version of getSiteInfo(['general'])
  client.siteinfo = function () {
    var client = this;
    if (this.dSiteinfo) {
      return this.dSiteinfo;
    }
    this.dSiteinfo = new Promise(function (resolve, reject) {
      client.getSiteInfo(['general'], function (err, info) {
        if (err) {
          reject(err);
          return;
        }
        // Simplify matching for wgPageName vs wgTitle
        info.general.mainpagename = info.general.mainpage.replace(/ /g, '_');
        resolve(info.general);
      });
    });
    return this.dSiteinfo;
  };
}

function getBotClient (server, authObj) {
  if (!bots[server]) {
    bots[server] = new Promise(function (resolve, reject) {
      var client = new MwClient({
        protocol: 'https',
        server: server,
        path: '/w',
        concurrency: 2,
        username: authObj.botname,
        password: authObj.botpass,
        debug: !!argv.verbose
      });
      client.logIn(function (err) {
        if (err) {
          reject(err);
          return;
        }
        enhanceMwClient(client);
        resolve(client);
      });
    });
  }
  return bots[server];
}

/**
 * @return {Promise} Map object
 */
function getWikiMap (authObj) {
  if (dMap) {
    return dMap;
  }
  dMap = (async function () {
    var client = await getBotClient('meta.wikimedia.org', authObj);

    return new Promise((resolve, reject) => {
      client.api.call({
        action: 'sitematrix',
        smlangprop: 'site',
        smsiteprop: 'url|dbname'
      }, function (err, sitematrix) {
        var map, key, group, i, wiki;
        if (err) {
          reject(err);
          return;
        }
        map = Object.create(null);
        for (key in sitematrix) {
          if (key === 'count') {
            continue;
          }
          group = key === 'specials' ? sitematrix[key] : sitematrix[key].site;
          if (group && group.length) {
            for (i = 0; i < group.length; i++) {
              if (group[i].private === undefined &&
                group[i].closed === undefined &&
                group[i].nonglobal === undefined &&
                group[i].fishbowl === undefined
              ) {
                wiki = group[i];
                wiki.server = new URL(wiki.url).host;
                map[wiki.dbname] = wiki;
              }
            }
          }
        }
        resolve(map);
      });
    });
  }());
  return dMap;
}

function printHeading (pageName, wiki) {
  console.log('\n' + colors.bold.underline(pageName) + ' (%s)\n', wiki);
}
function reportNoop () {
  console.log('No major changes. Loading next subject...');
}
function failPage (err) {
  var message;
  if (err instanceof SkipFileError) {
    message = `Skipped (${err.message})`;
  } else {
    message = 'Failed. ' + err.toString() + '\n';
  }
  console.log(`${message} Loading next subject...`);
}
function openPage (subject) {
  subject.opened = true;
  if (!subject.server) {
    console.log('Unable to find url for [[%s]]...', subject.pageName);
    return;
  }
  var url = 'https://' + subject.server + '/wiki/' + subject.pageName;
  console.log('Opening %s...', colors.bold.underline(url));
  opener(url);
}
function printApplyHelp () {
  var help = (
    'y - yes, accept this change\n' +
    'n - no, reject this change\n' +
    'a - accept all changes for this pattern in the current file\n' +
    'r - reject all changes for this pattern in the current file\n' +
    'e - edit the page in a web browser, and skip the rest of this file\n' +
    'o - open the page in a web browser for inspection, but keep the change undecided\n' +
    's - skip all remaining changes and patterns in this file\n' +
    'h - print help\n'
  );
  console.log(colors.red.bold(help));
}

async function confirmSaving (subject, summary, result) {
  var wiki = subject.server || subject.wikiId;

  if (result.didSomeAllOrAuto) {
    console.log('\nEdit summary: %s\n', summary);
    await ask.options(
      'One or more proposed changes were applied automatically.' +
        '\nDo you want to save these changes on ' + colors.bold.underline(subject.pageName) + '?',
      {
        yes: function (callback) {
          callback();
        },
        no: function (callback) {
          callback(new SkipFileError());
        }
      }
    );
  }

  console.log('\nEdit summary: %s\nSaving edit on [[%s]] (%s)...', summary, colors.bold(subject.pageName), wiki);
}

async function handleContent (subject, content, siteinfo) {
  var shown = false;
  var didSomeAllOrAuto = false;
  // A reference to a pattern object for which the user
  // has indicated they want to automatically accept all
  // replacements in the current file content.
  var currentAllOfPattern = null;

  /**
   * Accepter callback for Fixer#run.
   *
   * @param {string[]} lines All lines of current file
   * @param {number} i Current line number
   * @param {string} line Current line (original)
   * @param {string} replacement Current line (proposed)
   * @param {Object} pattern A pattern object for reference
   * @return {boolean} Whether to accept the change
   */
  async function proposeChange (lines, i, line, replacement, pattern) {
    var contextSize = 5;
    var contextStart = Math.max(0, i - 5);
    var linesBefore = lines.slice(contextStart, i).join('\n');
    var linesAfter = lines.slice(i + 1, i + contextSize).join('\n');
    var diff = Diff.simpleDiff(line, replacement);
    console.log(Diff.formatDiff(diff, contextStart, linesBefore, linesAfter));
    // Save yes/no decisions in a cache for convenient re-use.
    // The significant serialisation of the change is similar to diffStr,
    // but *including* linesBefore+After, and *without* line numbers.
    var decideCacheKey = JSON.stringify([
      [linesBefore, linesAfter],
      [diff.textBefore, diff.removed, diff.added, diff.textAfter]
    ]);
    var decision = decisionCache.get(decideCacheKey);
    var decisionName = (decision !== undefined ? (decision ? 'Yes' : 'No') : null);
    function askApply () {
      var readTimeout;
      shown = true;
      if (currentAllOfPattern !== pattern) {
        // Different pattern, stop any all-replacement
        currentAllOfPattern = null;
      }

      if (currentAllOfPattern === pattern) {
        // Active all-replacement, apply in 100ms.
        readTimeout = 100;
      } else if (decisionName) {
        // We've previously made a yes/no decision on a similar diff.
        // Assume the same response after a (configurable) timeout.
        // Round 0 to 1ms because read() interprets 0 as false.
        readTimeout = Math.max(argv.xt * 1000, 1);
        console.log('You previously decided for a similar diff: ' +
          colors.bold(decisionName) + '. ' +
          'Will assume ' + colors.bold(decisionName) + ' in ' +
          Math.round(argv.xt) + ' seconds...'
        );
      }
      return ask.options('Apply change?', {
        timeout: readTimeout
      }, {
        yes: function (cb) {
          decisionCache.set(decideCacheKey, true);
          cb(null, true);
        },
        no: function (cb) {
          decisionCache.set(decideCacheKey, false);
          // Stop any all-replacement
          currentAllOfPattern = null;
          cb();
        },
        all: function (cb) {
          // Start all-replacement
          currentAllOfPattern = pattern;
          cb(null, true);
        },
        reject: function (cb) {
          currentAllOfPattern = null;

          cb(new SkipPatternError());
        },
        edit: function (cb) {
          cb(new SkipFileError('Editing in browser'));
          openPage(subject);
        },
        open: function (cb) {
          openPage(subject);
          askApply().then(function (answer) {
            cb(null, answer);
          }, cb);
        },
        skip: function (cb) {
          cb(new SkipFileError());
        },
        help: function (cb) {
          printApplyHelp();
          askApply().then(function (answer) {
            cb(null, answer);
          }, cb);
        }
      });
    }
    try {
      return await askApply();
    } catch (err) {
      // Time-outs are used to communicate "all" and "auto" mode
      if (err && err.message === 'timed out') {
        if (argv.auto && decision !== undefined) {
          // Re-use cached decision in "auto" mode.
          console.log(decisionName + ' [assumed from cache]');
          didSomeAllOrAuto = true;
          return decision === true;
        } else if (currentAllOfPattern === pattern) {
          // Fix the same pattern blindly within a single file.
          console.log('[auto-accepted current pattern]');
          didSomeAllOrAuto = true;
          return true;
        }
      }

      // Re-throw as actual error
      throw err;
    }
  }

  await Content.checkSubject(subject, content, {
    quiet: argv.quickSkip === true
  });
  var fix = new Fixer(content, patterns, siteinfo);
  var result = await fix.run(replace, proposeChange);
  return {
    ...result,
    shown,
    didSomeAllOrAuto
  };
}

async function checkAll (subject, content) {
  if (argv.all &&
    (!argv.contains || content.indexOf(argv.contains) !== -1) &&
    (!argv.match || new RegExp(argv.match).test(content)) &&
    !subject.opened
  ) {
    let answer = await ask.confirm('Open in browser?');
    if (answer) {
      openPage(subject);
    }
  }
}

async function prefetchSubject (authObj, map, subject) {
  var wiki = map[subject.wikiId];
  if (!wiki) {
    return;
  }
  var client = await getBotClient(wiki.server, authObj);
  // Start pending promise and put into cache
  getPageCache.title = subject.pageName;
  getPageCache.server = wiki.server;
  getPageCache.promise = client.getPage(subject.pageName);
}

async function handleSubject (authObj, map, subject, preloadNext) {
  var wiki = map[subject.wikiId];
  if (!wiki) {
    printHeading(subject.pageName, subject.wikiId);
    throw new SkipFileError('Unknown wiki: ' + subject.wikiId);
  }
  // Hack for printSaving() and openPage()
  subject.server = wiki.server;

  printHeading(subject.pageName, wiki.server);
  if (subject.pageName === 'MediaWiki:Gadget-popups.js') {
    throw new SkipFileError('False positive');
  }
  var client = await getBotClient(wiki.server, authObj);
  var page;
  if (getPageCache.server === wiki.server && getPageCache.title === subject.pageName) {
    page = await getPageCache.promise;
  } else {
    page = await client.getPage(subject.pageName);
  }
  var siteinfo = await client.siteinfo();
  // At this point, we've got everything for the current subject,
  // let's start preloading the next!
  preloadNext();
  var result;
  try {
    result = await handleContent(subject, page.revision.content, siteinfo);
  } catch (err) {
    // Before discarding, offer to "open" if needed
    await checkAll(subject, page.revision.content);
    throw err;
  }

  // Before saving, offer to "open" if needed
  await checkAll(subject, page.revision.content);

  var newContent = result.content;
  if (!result.summaries.length) {
    if (result.shown) {
      // Before skipping, offer to "open" if needed
      await checkAll(subject, page.revision.content);
      // No change made, or only minor cleanup
      reportNoop();
    }
    return;
  }

  await Content.checkSubject(subject, newContent);
  var summary = 'Maintenance: [[mw:RL/MGU]] - ' + result.summaries.join(', ');

  await confirmSaving(subject, summary, result);

  // Save edit
  await new Promise(function (resolve, reject) {
    client.edit(page, newContent, summary, function (err) {
      err ? reject(new SkipFileError(err.message)) : resolve(); // promisify
    });
  });
}

async function start (authDir) {
  decisionCache = new DecisionStore({ enabled: argv.auto });
  var parsedResults;
  var i;
  function preloadNext () {
    let nextSubject = parsedResults[i + 1];
    if (nextSubject) {
      // Ignore async stack
      prefetchSubject(authObj, map, nextSubject);
    }
  }
  try {
    var authObj = await auth.getAuth(authDir);
    console.log(colors.cyan('Reading %s'), path.resolve(argv.file));
    var results = fs.readFileSync(argv.file).toString();
    var map = await getWikiMap(authObj);
    parsedResults = parseResults(results);
    for (i = 0; i < parsedResults.length; i++) {
      let subject = parsedResults[i];
      try {
        await handleSubject(authObj, map, subject, preloadNext);
      } catch (err) {
        failPage(err);
      }
    }
  } catch (mainErr) {
    if (mainErr instanceof AbortError) {
      return;
    }
    if (mainErr) {
      console.error(mainErr);
      process.exit(1);
    }
  }
}

module.exports = function cli (authDir) {
  if (argv.help) {
    console.log('Help for Tourbot v' + require('../package.json').version);
    console.log('  -f, --file FILE      File that contains a list of pages to process. Default: results.txt');
    console.log('  -a, --all            Enable interactive mode for all page names, even without matches. Default: off');
    console.log('  -c, --contains TEXT  Limit the `all` iteration to pages that currently contain the given text.');
    console.log('  -m, --match TEXT     Similar to the `contains` parameter, but interpreted as a regular expression.');
    console.log('  -x, --auto           Enable remembering of decisions and re-apply them automatically to similar diffs. Default: off');
    console.log('  --xt NUM             Change the timeout used by --auto mode (in seconds). Default: 3');
    console.log('  -v, --verbose        Enable debug logging. Default: off');
    console.log('  --quick-skip         Skip files with script errors without an interactive prompt. Default: off');
    console.log('  -h, --help           Show this help page, instead of running the tourbot.');
    return;
  }
  if (typeof argv.xt !== 'number' || !isFinite(argv.xt) || argv.xt < 0) {
    // Rejects: non-numbers, NaN, (-)Infinity, and negative numbers.
    // Accepts: 0 and any finite positive number.
    console.error('Invalid parameter for --xt. Must be a non-negative number.');
    process.exit(1);
  }
  start(authDir);
};
