/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import XlinkController from './controllers/XlinkController.js';
import XlinkLoader from './XlinkLoader.js';
import RequestModifierExtensions from './extensions/RequestModifierExtensions.js';
import Error from './vo/Error.js';
import HTTPRequest from './vo/metrics/HTTPRequest.js';
import EventBus from './utils/EventBus.js';
import Events from './Events.js';
import FactoryMaker from '../core/FactoryMaker.js';

const RETRY_ATTEMPTS = 3;
const RETRY_INTERVAL = 500;
const PARSERERROR_ERROR_CODE = 1;

export default FactoryMaker.getClassFactory(ManifestLoader);

function ManifestLoader(config) {
    const self = this;

    let eventBus = EventBus(self.context).getInstance();

    let log = config.log;
    let parser = config.parser;
    let errHandler = config.errHandler;
    let metricsModel = config.metricsModel;

    let instance = {
        load: load,
        reset: reset
    };

    setup();
    return instance;

    let requestModifierExt,
        xlinkController;

    function setup() {
        let xlinkLoader = XlinkLoader(self.context).create({errHandler:errHandler, metricsModel:metricsModel});
        xlinkController = XlinkController(self.context).create({xlinkLoader:xlinkLoader});
        requestModifierExt = RequestModifierExtensions(self.context).getInstance();
        eventBus.on(Events.XLINK_READY, onXlinkReady, instance);
    }

    function load (url) {
        var baseUrl = parseBaseUrl(url);
        var request = new XMLHttpRequest(),
            requestTime = new Date(),
            loadedTime = null,
            needFailureReport = true,
            manifest,
            onload,
            report,
            progress,
            firstProgressCall;

        onload = function () {
            var actualUrl = null,
                errorMsg;

            if (request.status < 200 || request.status > 299) {
                return;
            }

            needFailureReport = false;
            loadedTime = new Date();

            // Handle redirects for the MPD - as per RFC3986 Section 5.1.3
            if (request.responseURL && request.responseURL !== url) {
                baseUrl = parseBaseUrl(request.responseURL);
                actualUrl = request.responseURL;
            }

            metricsModel.addHttpRequest("stream",
                null,
                HTTPRequest.MPD_TYPE,
                url,
                actualUrl,
                null,
                requestTime,
                request.firstByteDate || null,
                loadedTime,
                request.status,
                null,
                request.getAllResponseHeaders());

            manifest = parser.parse(request.responseText, baseUrl, xlinkController);

            if (manifest) {
                manifest.url = actualUrl || url;
                manifest.loadedTime = loadedTime;
                metricsModel.addManifestUpdate("stream", manifest.type, requestTime, loadedTime, manifest.availabilityStartTime);
                xlinkController.resolveManifestOnLoad(manifest);
            } else {
                errorMsg = "Failed loading manifest: " + url + ", parsing failed";
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {manifest: null, error:new Error(PARSERERROR_ERROR_CODE, errorMsg, null)});
                log(errorMsg);
            }
        };

        report = function () {
            if (!needFailureReport)
            {
                return;
            }
            needFailureReport = false;

            metricsModel.addHttpRequest("stream",
                null,
                HTTPRequest.MPD_TYPE,
                url,
                request.responseURL || null,
                null,
                requestTime,
                request.firstByteDate || null,
                new Date(),
                request.status,
                null,
                request.getAllResponseHeaders());
            if (RETRY_ATTEMPTS > 0) {
                log("Failed loading manifest: " + url + ", retry in " + RETRY_INTERVAL + "ms" + " attempts: " + remainingAttempts);
                remainingAttempts--;
                setTimeout(function() {
                    load(url);
                }, RETRY_INTERVAL);
            } else {
                log("Failed loading manifest: " + url + " no retry attempts left");
                errHandler.downloadError("manifest", url, request);
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {error:new Error("Failed loading manifest: " + url + " no retry attempts left")});
            }
        };

        progress = function (event) {
            if (firstProgressCall) {
                firstProgressCall = false;
                if (!event.lengthComputable || (event.lengthComputable && event.total != event.loaded)) {
                    request.firstByteDate = new Date();
                }
            }
        };

        try {
            //log("Start loading manifest: " + url);
            request.onload = onload;
            request.onloadend = report;
            request.onerror = report;
            request.onprogress = progress;
            request.open("GET", requestModifierExt.modifyRequestURL(url), true);
            request.send();
        } catch(e) {
            request.onerror();
        }
    }

    function reset() {
        eventBus.off(Events.XLINK_READY, onXlinkReady, instance);
        requestModifierExt = null;
        xlinkController = null;
    }

    function parseBaseUrl(url) {
        var base = "";

        if (url.indexOf("/") !== -1)
        {
            if (url.indexOf("?") !== -1) {
                url = url.substring(0, url.indexOf("?"));
            }
            base = url.substring(0, url.lastIndexOf("/") + 1);
        }

        return base;
    }

    function onXlinkReady(event) {
        eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, { manifest: event.manifest });
    }
}