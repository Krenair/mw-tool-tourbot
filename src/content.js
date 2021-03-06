var acorn = require('acorn');
var colors = require('colors/safe');

var ask = require('./ask');
var { SkipFileError } = require('./error');

/**
 * @private
 */
function checkScript (content, options) {
  function confirmError (error) {
    var line = content.split('\n')[error.loc.line - 1];
    var context = line.slice(0, error.loc.column) +
      colors.bold.underline(line[error.loc.column]) +
      line.slice(error.loc.column + 1);
    return ask.options(
      colors.red.bold(error.toString()) +
        '\n' + context +
        '\n\nContinue?',
      {
        yes: function (callback) {
          callback();
        },
        no: function (callback) {
          callback(new SkipFileError('Script error'));
        }
      }
    );
  }
  try {
    acorn.parse(content, { ecmaVersion: 5 });
    return Promise.resolve();
  } catch (e) {
    return options.quiet ? Promise.reject(e) : confirmError(e);
  }
}

/**
 * @param {Object} subject
 * @param {string} subject.pageName
 * @param {string} content
 * @param {Object} [options]
 * @param {boolean} [options.quiet=false]
 * @return {Promise}
 */
function checkSubject (subject, content, options = {}) {
  if (subject.pageName.slice(-4) === '.css') {
    return Promise.resolve();
  }
  return checkScript(content, options);
}

module.exports = { checkSubject };
