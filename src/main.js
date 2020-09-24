const Apify = require('apify');
const { USER_AGENT } = require('./consts');

const { downloadListOfUrls } = Apify.utils;

const { extractDetail, listPageFunction } = require('./extraction.js');
const { checkDate, checkDateGap, retireBrowser, isObject } = require('./util.js');
const {
    getAttribute, enqueueLinks, addUrlParameters,
    getWorkingBrowser, fixUrl, isFiltered,
    isMinMaxPriceSet, setMinMaxPrice, isPropertyTypeSet,
    setPropertyType, enqueueAllPages, isAutocompletionSet, setAutocompletion
} = require('./util.js');
const csvToJson = require('csvtojson');

const { log, requestAsBrowser } = Apify.utils;

/** Main function */
Apify.main(async () => {
    // Actor INPUT variable
    const input = await Apify.getValue('INPUT');

    // const input = {
    //   "destType": "city",
    //   "googlesheetLink": "https://docs.google.com/spreadsheets/d/1mnCxzaz1gBmAFUHE7uwfhdCyoVbzKox1_qIAqfvSnjs/edit?usp=sharing",
    //   "sortBy": "bayesian_review_score",
    //   "currency": "EUR",
    //   "language": "en-gb",
    //   "minMaxPrice": "none",
    //   "propertyType": "Hotels",
    //   "proxyConfig": {
    //     "useApifyProxy": false,
    //     "apifyProxyGroups": [
    //       "SHADER"
    //     ]
    //   },
    //   "simple": true,
    //   "useFilters": false,
    //   "testProxy": false,
    //   "extendOutputFunction": "($) => { return {} }",
    //   "checkIn": "",
    //   "checkOut": "",
    //   "rooms": 1,
    //   "adults": 2,
    //   "children": 0
    // }

    // Actor STATE variable
    const state = await Apify.getValue('STATE') || { crawled: {} };

    // Migrating flag
    let migrating = false;
    Apify.events.on('migrating', () => { migrating = true; });

    if (!input.search && !input.googlesheetLink) {
        throw new Error('Missing "search" or "googlesheetLink" attribute in INPUT!');
    } else if (input.search && input.googlesheetLink && input.search.trim().length > 0 && input.googlesheetLink.length > 0) {
        throw new Error('It is not possible to use both "search" and "googlesheetLink" attributes in INPUT!');
    }
    if (!(input.proxyConfig && input.proxyConfig.useApifyProxy)) {
        throw new Error('This actor cannot be used without Apify proxy.');
    }
    if (input.useFilters && input.propertyType !== 'none') {
        throw new Error('Property type and filters cannot be used at the same time.');
    }

    const daysInterval = checkDateGap(checkDate(input.checkIn), checkDate(input.checkOut));

    if (daysInterval >= 30) {
        log.warning(`=============
        The selected check-in and check-out dates have ${daysInterval} days between them.
        Some listings won't return available room information!

        Decrease the days interval to fix this
      =============`);
    } else if (daysInterval > 0) {
        log.info(`Using check-in / check-out with an interval of ${daysInterval} days`);
    }

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            // eslint-disable-next-line no-eval
            extendOutputFunction = eval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    if (input.minScore) { input.minScore = parseFloat(input.minScore); }
    const sortBy = input.sortBy || 'bayesian_review_score';
    const requestQueue = await Apify.openRequestQueue();

    let startUrl;
    let requestList;

    if (input.googlesheetLink) {
        const [ googlesheet ] = input.googlesheetLink.match(/.*\/spreadsheets\/d\/.*\//);
        const sourceUrl = `${googlesheet}gviz/tq?tqx=out:csv`;
        const response = await requestAsBrowser({ url: sourceUrl, encoding: 'utf8' });

        const rows = await csvToJson().fromString(response.body);
        log.info('Google sheets rows = ' + rows.length);

        const urlList = [];
        startUrl = addUrlParameters('https://www.booking.com/searchresults.html?dest_type=city&ss=paris&order=popularity', input);
        for (let index = 0; index < rows.length; index++) {
            const { id, type, name, city, country } = rows[index];
            if (!name) { return false }
            Apify.utils.log.info(`csv extraction: ${id} ${type} ${name} ${city} ${country}`);
            request = {
              url: startUrl,
              uniqueKey: id,
              userData: {
                id,
                type,
                name,
                city,
                country,
                label: 'start'
              }
            };

            urlList.push(request)
        }
        log.info(`urlList: ${urlList.length}`)
        requestList = new Apify.RequestList({ sources: urlList });
        await requestList.initialize();
    } else {
        // Create startURL based on provided INPUT.
        log.info('Starting crawling from search input.');
        const dType = input.destType || 'city';
        const query = encodeURIComponent(input.search);
        startUrl = `https://www.booking.com/searchresults.html?dest_type=${dType}&ss=${query}&order=${sortBy}`;
        startUrl = addUrlParameters(startUrl, input);

        // Enqueue all pagination pages.
        startUrl += '&rows=25';
        log.info(`startUrl: ${startUrl}`);
        await requestQueue.addRequest({ url: startUrl, userData: { label: 'start' } });
        if (!input.useFilters && input.propertyType === 'none' && input.maxPages) {
            for (let i = 1; i < input.maxPages; i++) {
                await requestQueue.addRequest({
                    url: `${startUrl}&offset=${25 * i}`,
                    userData: { label: 'page' },
                });
            }
        }
    }

    const proxyConfiguration = await Apify.createProxyConfiguration({
        ...input.proxyConfig,
    });

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        handlePageTimeoutSecs: 120,
        maxRequestRetries: 1,
        proxyConfiguration,
        launchPuppeteerOptions: {
            // headless: false,
            // devtools: true,
            ignoreHTTPSErrors: true,
            useChrome: Apify.isAtHome(),
            // slowMo: 50,
            args: [
                '--ignore-certificate-errors',
            ],
            stealth: true,
            stealthOptions: {
                addPlugins: false,
                emulateWindowFrame: false,
                emulateWebGL: false,
                emulateConsoleDebug: false,
                addLanguage: false,
                hideWebDriver: true,
                hackPermissions: false,
                mockChrome: false,
                mockChromeInIframe: false,
                mockDeviceMemory: false,
            },
            userAgent: USER_AGENT,
        },
        launchPuppeteerFunction: async (options) => {
            if (!input.testProxy) {
                return Apify.launchPuppeteer({
                    ...options,
                });
            }

            return getWorkingBrowser(startUrl, input, options);
        },

        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            log.info(`handle request: ${request.userData.label} - ${request.userData.type} - ${request.userData.name} - ${request.userData.city}`);
            log.info(`open url: ${await page.url()}`);

            // Check if startUrl was open correctly
            if (input.startUrls) {
                const pageUrl = await page.url();
                if (pageUrl.length < request.url.length) {
                    log.info('startUrl was not open correctly')
                    await retireBrowser(puppeteerPool, page, requestQueue, request);
                    return;
                }
            }

            // Check if page was loaded with correct currency.
            const curInput = await page.$('input[name="selected_currency"]');
            const currency = await getAttribute(curInput, 'value');

            if (!currency || currency !== input.currency) {
                log.info(`Wrong currency: ${currency}, re-enqueuing...`)
                await retireBrowser(puppeteerPool, page, requestQueue, request);
                throw new Error(`Wrong currency: ${currency}, re-enqueuing...`);
            }

            if (request.userData.label === 'detail') { // Extract data from the hotel detail page
                // wait for necessary elements
                log.info('Extract data from the hotel detail page')
                try { await page.waitForSelector('.hprt-occupancy-occupancy-info'); } catch (e) { log.info('occupancy info not found'); }

                const ldElem = await page.$('script[type="application/ld+json"]');
                const ld = JSON.parse(await getAttribute(ldElem, 'textContent'));
                await Apify.utils.puppeteer.injectJQuery(page);

                // Check if the page was open through working proxy.
                // const pageUrl = await page.url();
                // if (!input.startUrls && pageUrl.indexOf('label') < 0) {
                //     log.info(`page not open through working proxy`)
                //     await retireBrowser(puppeteerPool, page, requestQueue, request);
                //     return;
                // }

                // Exit if core data is not present ot the rating is too low.
                if (!ld || (ld.aggregateRating && ld.aggregateRating.ratingValue <= (input.minScore || 0))) {
                    return;
                }

                // Extract the data.
                log.info('extracting detail...');
                const detail = await extractDetail(page, ld, input, request.userData);
                log.info('detail extracted');
                let userResult = {};

                if (extendOutputFunction) {
                    userResult = await page.evaluate(async (functionStr) => {
                        // eslint-disable-next-line no-eval
                        const f = eval(functionStr);
                        return f(window.jQuery);
                    }, input.extendOutputFunction);

                    if (!isObject(userResult)) {
                        log.info('extendOutputFunction has to return an object!!!');
                        process.exit(1);
                    }
                }

                await Apify.pushData({ ...detail, ...userResult });
            } else {
                // Handle hotel list page.
                log.info('Handle hotel list page.')
                const filtered = await isFiltered(page);
                const settingFilters = input.useFilters && !filtered;
                const settingMinMaxPrice = input.minMaxPrice !== 'none' && !await isMinMaxPriceSet(page, input);
                const settingPropertyType = input.propertyType !== 'none' && !await isPropertyTypeSet(page, input);
                const settingAutocompletion = !await isAutocompletionSet(page, input, request.userData.name);
                const enqueuingReady = !(settingFilters || settingMinMaxPrice || settingPropertyType);

                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if (!input.startUrls && !input.googlesheetLink && pageUrl.indexOf(sortBy) < 0) {
                    log.info(`page not open through working proxy`)
                    await retireBrowser(puppeteerPool, page, requestQueue, request);
                    return;
                }

                // If it's aprropriate, enqueue all pagination pages
                if (!input.googlesheetLink && enqueuingReady && (!input.maxPages || input.minMaxPrice !== 'none' || input.propertyType !== 'none')) {
                    enqueueAllPages(page, requestQueue, input);
                }

                // If property type is enabled, enqueue necessary page.
                if (settingPropertyType) {
                    await setPropertyType(page, input, requestQueue, request.userData);
                    return
                }

                // If min-max price is enabled, enqueue necessary page.
                if (settingMinMaxPrice && !settingPropertyType) {
                    await setMinMaxPrice(page, input, requestQueue);
                }

                // If filtering is enabled, enqueue necessary pages.
                if (input.useFilters && !filtered) {
                    log.info('enqueuing filtered pages...');

                    await enqueueLinks(page, requestQueue, '.filterelement', null, 'page', fixUrl('&', input), async (link) => {
                        const lText = await getAttribute(link, 'textContent');
                        return `${lText}_0`;
                    });
                }

                if (settingAutocompletion) {
                    await setAutocompletion(page, input, request.userData);
                }

                const items = await page.$$('.sr_property_block.sr_item:not(.soldout_property)');
                if (items.length === 0) {
                    log.info('Found no result. Skipping..');
                    return;
                }
                log.info(`enqueuingReady:${enqueuingReady}`)
                log.info(`input.simple:${input.simple}`)
                if (enqueuingReady && input.simple) { // If simple output is enough, extract the data.
                    log.info('extracting data...');
                    await Apify.utils.puppeteer.injectJQuery(page);
                    // we extract only the first result of page
                    let feelingLucky = true
                    const result = await page.evaluate(listPageFunction, input, feelingLucky, request.userData);
                    log.info(`Found ${result.length} results`);
                    log.info(`First result name ${result[0].name}`);
                    if (result.length > 0) {
                        if (feelingLucky && result[0].name.toLowerCase().indexOf(request.userData.name.toLowerCase()) < 0) {
                            // first result does not match
                            throw new Error('first result name does not match.');
                        }else {
                            const toBeAdded = [];
                            for (const item of result) {
                                item.url = addUrlParameters(item.url, input);
                                if (!state.crawled[item.name]) {
                                    toBeAdded.push(item);
                                    state.crawled[item.name] = true;
                                }
                            }
                            if (migrating) { await Apify.setValue('STATE', state); }
                            if (toBeAdded.length > 0) {
                                await Apify.pushData(toBeAdded);
                            }
                        }

                    }
                } else if (enqueuingReady) { // If not, enqueue the detail pages to be extracted.
                    log.info('enqueuing detail page from first search result...');
                    const urlMod = fixUrl('&', input);
                    const keyMod = async (link) => (await getAttribute(link, 'textContent')).trim().replace(/\n/g, '');
                    const prItem = await page.$('.bui-pagination__info');
                    const pageRange = (await getAttribute(prItem, 'textContent')).match(/\d+/g);
                    const firstItem = parseInt(pageRange && pageRange[0] ? pageRange[0] : '1', 10);
                    const links = await page.$$('.sr_property_block.sr_item:not(.soldout_property) .hotel_name_link');

                    // index first item only
                    iLink = 0
                    const link = links[iLink];
                    const href = await getAttribute(link, 'href');

                    if (href) {
                        const uniqueKeyCal = keyMod ? (await keyMod(link)) : href;
                        const urlModCal = urlMod ? urlMod(href) : href;

                        await requestQueue.addRequest({
                            userData: {
                                label: 'detail',
                                order: iLink + firstItem,
                            },
                            url: urlModCal,
                            uniqueKey: uniqueKeyCal,
                        }, { forefront: true });
                    }
                }
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.info(`Request ${request.url} failed too many times`);
            // await Apify.pushData({
            //     '#debug': Apify.utils.createRequestDebugInfo(request),
            // });
            await Apify.pushData({
                url: null,
                name: null,
                rating: null,
                reviews: null,
                stars: null,
                price: null,
                currency: null,
                roomType: null,
                persons: null,
                address: null,
                location: null,
                image: null,
                _inputId: request.userData.id,
                _inputType: request.userData.type,
                _inputName: request.userData.name,
                _inputCity: request.userData.city,
                _inputCountry: request.userData.country
            });
        },

        gotoFunction: async ({ page, request }) => {
            await Apify.utils.puppeteer.blockRequests(page);
            const cookies = await page.cookies('https://www.booking.com');
            await page.deleteCookie(...cookies);
            await page.setViewport({
                width: 1024 + Math.floor(Math.random() * 100),
                height: 768 + Math.floor(Math.random() * 100),
            });

            return page.goto(request.url, { timeout: 200000 });
        },
    });

    await crawler.run();
});
