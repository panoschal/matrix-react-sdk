/*
Copyright 2017 OpenMarket Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import pako from 'pako';

import {MatrixClientPeg} from '../MatrixClientPeg';
import PlatformPeg from '../PlatformPeg';
import { _t } from '../languageHandler';
import Tar from "tar-js";

import * as rageshake from './rageshake';


// polyfill textencoder if necessary
import * as TextEncodingUtf8 from 'text-encoding-utf-8';
import SettingsStore from "../settings/SettingsStore";
let TextEncoder = window.TextEncoder;
if (!TextEncoder) {
    TextEncoder = TextEncodingUtf8.TextEncoder;
}

async function collectBugReport(opts) {
    opts = opts || {};
    const progressCallback = opts.progressCallback || (() => {});

    progressCallback(_t("Collecting app version information"));
    let version = "UNKNOWN";
    try {
        version = await PlatformPeg.get().getAppVersion();
    } catch (err) {} // PlatformPeg already logs this.

    let userAgent = "UNKNOWN";
    if (window.navigator && window.navigator.userAgent) {
        userAgent = window.navigator.userAgent;
    }

    const client = MatrixClientPeg.get();

    console.log("Sending bug report.");

    const body = new FormData();
    body.append('text', opts.userText || "User did not supply any additional text.");
    body.append('app', 'riot-web');
    body.append('version', version);
    body.append('user_agent', userAgent);

    if (client) {
        body.append('user_id', client.credentials.userId);
        body.append('device_id', client.deviceId);
    }

    if (opts.label) {
        body.append('label', opts.label);
    }

    // add labs options
    const enabledLabs = SettingsStore.getLabsFeatures().filter(SettingsStore.isFeatureEnabled);
    if (enabledLabs.length) {
        body.append('enabled_labs', enabledLabs.join(', '));
    }

    if (opts.sendLogs) {
        progressCallback(_t("Collecting logs"));
        const logs = await rageshake.getLogsForReport();
        for (const entry of logs) {
            // encode as UTF-8
            const buf = new TextEncoder().encode(entry.lines);

            // compress
            const compressed = pako.gzip(buf);

            body.append('compressed-log', new Blob([compressed]), entry.id);
        }
    }

    return body;
}

/**
 * Send a bug report.
 *
 * @param {string} bugReportEndpoint HTTP url to send the report to
 *
 * @param {object} opts optional dictionary of options
 *
 * @param {string} opts.userText Any additional user input.
 *
 * @param {boolean} opts.sendLogs True to send logs
 *
 * @param {function(string)} opts.progressCallback Callback to call with progress updates
 *
 * @return {Promise} Resolved when the bug report is sent.
 */
export default async function sendBugReport(bugReportEndpoint, opts) {
    if (!bugReportEndpoint) {
        throw new Error("No bug report endpoint has been set.");
    }

    opts = opts || {};
    const progressCallback = opts.progressCallback || (() => {});
    const body = await collectBugReport(opts);

    progressCallback(_t("Uploading report"));
    await _submitReport(bugReportEndpoint, body, progressCallback);
}

/**
 * Downloads the files from a bug report. This is the same as sendBugReport,
 * but instead causes the browser to download the files locally.
 *
 * @param {object} opts optional dictionary of options
 *
 * @param {string} opts.userText Any additional user input.
 *
 * @param {boolean} opts.sendLogs True to send logs
 *
 * @param {function(string)} opts.progressCallback Callback to call with progress updates
 *
 * @return {Promise} Resolved when the bug report is downloaded (or started).
 */
export async function downloadBugReport(opts) {
    opts = opts || {};
    const progressCallback = opts.progressCallback || (() => {});
    const body = await collectBugReport(opts);

    progressCallback(_t("Downloading report"));
    let metadata = "";
    const tape = new Tar();
    let i = 0;
    for (const e of body.entries()) {
        if (e[0] === 'compressed-log') {
            await new Promise((resolve => {
                const reader = new FileReader();
                reader.addEventListener('loadend', ev => {
                    tape.append(`log-${i++}.log`, pako.ungzip(ev.target.result));
                    resolve();
                });
                reader.readAsArrayBuffer(e[1]);
            }))
        } else {
            metadata += `${e[0]} = ${e[1]}\n`;
        }
    }
    tape.append('issue.txt', metadata);

    // We have to create a new anchor to download if we want a filename. Otherwise we could
    // just use window.open.
    const dl = document.createElement('a');
    dl.href = `data:application/octet-stream;base64,${btoa(uint8ToString(tape.out))}`;
    dl.download = 'rageshake.tar';
    document.body.appendChild(dl);
    dl.click();
    document.body.removeChild(dl);
}

// Source: https://github.com/beatgammit/tar-js/blob/master/examples/main.js
function uint8ToString(buf) {
    let i, length, out = '';
    for (i = 0, length = buf.length; i < length; i += 1) {
        out += String.fromCharCode(buf[i]);
    }

    return out;
}

function _submitReport(endpoint, body, progressCallback) {
    return new Promise((resolve, reject) => {
        const req = new XMLHttpRequest();
        req.open("POST", endpoint);
        req.timeout = 5 * 60 * 1000;
        req.onreadystatechange = function() {
            if (req.readyState === XMLHttpRequest.LOADING) {
                progressCallback(_t("Waiting for response from server"));
            } else if (req.readyState === XMLHttpRequest.DONE) {
                // on done
                if (req.status < 200 || req.status >= 400) {
                    reject(new Error(`HTTP ${req.status}`));
                    return;
                }
                resolve();
            }
        };
        req.send(body);
    });
}
