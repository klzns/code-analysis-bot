/**
 * Copyright (c) 2016-present, Breno Calazans
 * Copyright (c) 2015-2016, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

if (!process.env.CI_OWNER) {
  console.error('Missing CI_OWNER. Example: brenoc');
  process.exit(1);
}
if (!process.env.CI_REPO) {
  console.error('Missing CI_REPO. Example: code-analysis-bot');
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  console.error('Missing GITHUB_TOKEN. Example: 5fd88b964fa214c4be2b144dc5af5d486a2f8c1e');
  process.exit(1);
}
if (!process.env.PULL_REQUEST_NUMBER) {
  console.error('Missing PULL_REQUEST_NUMBER. Example: 2');
  // for master branch don't throw and error
  process.exit(0);
}

var GitHubApi = require('github');
var path = require('path');

var github = new GitHubApi({
  version: '3.0.0',
});

github.authenticate({
  type: 'oauth',
  token: process.env.GITHUB_TOKEN,
});

function push(arr, key, value) {
  if (!arr[key]) {
    arr[key] = [];
  }
  arr[key].push(value);
}

/**
 * There is unfortunately no standard format to report an error, so we have
 * to write a specific converter for each tool we want to support.
 *
 * Those functions take a json object as input and fill the output with the
 * following format:
 *
 * { [ path: string ]: Array< { message: string, line: number }> }
 *
 * This is an object where the keys are the path of the files and values
 * is an array of objects of the shape message and line.
 */
var converters = {
  raw: function(output, input) {
    for (var key in input) {
      input[key].forEach(function(message) {
        push(output, key, message);
      });
    }
  },

  flow: function(output, input) {
    if (!input || !input.errors) {
      return;
    }

    input.errors.forEach(function(error) {
      push(output, error.message[0].path, {
        message: error.message.map(message => message.descr).join(' '),
        line: error.message[0].line,
      });
    });
  },

  eslint: function(output, input) {
    if (!input) {
      return;
    }

    input.forEach(function(file) {
      file.messages.forEach(function(message) {
        push(output, file.filePath, {
          message: message.ruleId + ': ' + message.message,
          line: message.line,
        });
      });
    });
  }
};

function getShaFromPullRequest(owner, repo, number, callback) {
  github.pullRequests.get({owner, repo, number}, (error, res) => {
    if (error) {
      console.log(error);
      return;
    }
    callback(res.head.sha);
  });
}

function getFilesFromCommit(owner, repo, sha, callback) {
  github.repos.getCommit({owner, repo, sha}, (error, res) => {
    if (error) {
      console.log(error);
      return;
    }
    callback(res.files);
  });
}


/**
 * Sadly we can't just give the line number to github, we have to give the
 * line number relative to the patch file which is super annoying. This
 * little function builds a map of line number in the file to line number
 * in the patch file
 */
function getLineMapFromPatch(patchString) {
  var diffLineIndex = 0;
  var fileLineIndex = 0;
  var lineMap = {};

  patchString.split('\n').forEach((line) => {
    if (line.match(/^@@/)) {
      fileLineIndex = line.match(/\+([0-9]+)/)[1] - 1;
      return;
    }

    diffLineIndex++;
    if (line[0] !== '-') {
      fileLineIndex++;
      if (line[0] === '+') {
        lineMap[fileLineIndex] = diffLineIndex;
      }
    }
  });

  return lineMap;
}

function sendComment(owner, repo, number, sha, filename, lineMap, message) {
  if (!lineMap[message.line]) {
    // Do not send messages on lines that did not change
    return;
  }

  var opts = {
    owner,
    repo,
    number,
    sha,
    path: filename,
    commit_id: sha,
    body: message.message,
    position: lineMap[message.line],
  };
  github.pullRequests.createComment(opts, function(error) {
    if (error) {
      console.log(error);
      return;
    }
  });
  console.log('Sending comment', opts);
}

function main(messages, owner, repo, number) {
  // No message, we don't need to do anything :)
  if (Object.keys(messages).length === 0) {
    return;
  }

  getShaFromPullRequest(owner, repo, number, (sha) => {
    getFilesFromCommit(owner, repo, sha, (files) => {
      files
        .filter((file) => messages[file.filename])
        .forEach((file) => {
          var lineMap = getLineMapFromPatch(file.patch);
          messages[file.filename].forEach((message) => {
            sendComment(owner, repo, number, sha, file.filename, lineMap, message);
          });
        });
    });
  });
}

var content = '';
function start() {
  var messages = {};

  // Since we send a few http requests to setup the process, we don't want
  // to run this file one time per code analysis tool. Instead, we write all
  // the results in the same stdin stream.
  // The format of this stream is
  //
  //   name-of-the-converter
  //   {"json":"payload"}
  //   name-of-the-other-converter
  //   {"other": ["json", "payload"]}
  //
  // In order to generate such stream, here is a sample bash command:
  //
  //   cat <(echo eslint; npm run lint --silent -- --format=json; echo flow; flow --json) | node code-analysis-bot.js

  var lines = content.trim().split('\n');
  for (var i = 0; i < Math.ceil(lines.length / 2); ++i) {
    var converter = converters[lines[i * 2]];
    if (!converter) {
      throw new Error('Unknown converter ' + lines[i * 2]);
    }
    var json;
    try {
      json = JSON.parse(lines[i * 2 + 1]);
    } catch (e) {}

    converter(messages, json);
  }

  // The paths are returned in absolute from code analysis tools but github works
  // on paths relative from the root of the project. Doing the normalization here.
  var pwd = path.resolve('.');
  for (var absolutePath in messages) {
    var relativePath = path.relative(pwd, absolutePath);
    if (relativePath === absolutePath) {
      continue;
    }
    messages[relativePath] = messages[absolutePath];
    delete messages[absolutePath];
  }

  var owner = process.env.CI_OWNER;
  var repo = process.env.CI_REPO;
  var number = process.env.PULL_REQUEST_NUMBER;

  // intentional lint warning to make sure that the bot is working :)
  main(messages, owner, repo, number);
}

process.stdin.resume();
process.stdin.on('data', function(buf) { content += buf.toString(); });
process.stdin.on('end', start);

if (process.env.NODE_ENV === 'development') {
  content = `eslint
[{"filePath":"/Users/breno/Projects/code-analysis-bot/index.js","messages":[],"errorCount":0,"warningCount":0},{"filePath":"/Users/breno/Projects/code-analysis-bot/exampleFile.js","messages":[{"ruleId":"strict","severity":2,"message":"Use the global form of 'use strict'.","line":1,"column":1,"nodeType":"Program","source":"var a = (true && false);"},{"ruleId":"no-unused-vars","severity":2,"message":"'a' is assigned a value but never used.","line":1,"column":5,"nodeType":"Identifier","source":"var a = (true && false);"},{"ruleId":"no-extra-parens","severity":2,"message":"Gratuitous parentheses around expression.","line":1,"column":9,"nodeType":"LogicalExpression","source":"var a = (true && false);","fix":{"range":[8,23],"text":"true && false"}}],"errorCount":3,"warningCount":0,"source":"var a = (true && false);"}]`;
  start();
}
