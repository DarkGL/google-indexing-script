import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getAccessToken } from './shared/auth.mjs';
import {
    convertToSiteUrl,
    getEmojiForStatus,
    getPageIndexingStatus,
    getPublishMetadata,
    requestIndexing,
} from './shared/gsc.mjs';
import { getSitemapPages } from './shared/sitemap.mjs';
import { batch } from './shared/utils.mjs';

const CACHE_TIMEOUT = 1000 * 60 * 60 * 24 * 14; // 14 days
const input = process.argv[2];

if (!input) {
    console.error('❌ Please provide a domain or site URL as the first argument.');
    console.error('');
    process.exit(1);
}

const accessToken = await getAccessToken();
const siteUrl = convertToSiteUrl(input);
console.log(`🔎 Processing site: ${siteUrl}`);
const cachePath = `.cache/${siteUrl
    .replace('http://', 'http_')
    .replace('https://', 'https_')
    .replace('sc-domain:', '')
    .replace('/', '_')}.json`;
mkdirSync('.cache', { recursive: true });

console.log('Cache path:', cachePath);

const [sitemaps, pages] = await getSitemapPages(accessToken, siteUrl);

if (sitemaps.length === 0) {
    console.error('❌ No sitemaps found, add them to Google Search Console and try again.');
    console.error('');
    process.exit(1);
}

console.log(`👉 Found ${pages.length} URLs in ${sitemaps.length} sitemap`);

const statusPerUrl = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const pagesPerStatus = {};

console.log('Cache loaded', Object.keys(statusPerUrl).length);

const indexableStatuses = [
    'Discovered - currently not indexed',
    'Crawled - currently not indexed',
    'URL is unknown to Google',
    'Forbidden',
    'Error',
];

const shouldRecheck = (status, lastCheckedAt) => {
    const shouldIndexIt = indexableStatuses.includes(status);
    const isOld = new Date(lastCheckedAt) < new Date(Date.now() - CACHE_TIMEOUT);
    return shouldIndexIt || isOld;
};

await batch(
    async (url) => {
        let result = statusPerUrl[url];
        if (!result || shouldRecheck(result.status, result.lastCheckedAt)) {
            const status = await getPageIndexingStatus(accessToken, siteUrl, url);
            result = { status, lastCheckedAt: new Date().toISOString() };
            statusPerUrl[url] = result;
        }

        pagesPerStatus[result.status] = pagesPerStatus[result.status]
            ? [...pagesPerStatus[result.status], url]
            : [url];

        // Check if the URL is indexable and request indexing
        if (indexableStatuses.includes(result.status)) {
            console.log(`📄 Processing url for indexing: ${url}`);
            const publishStatus = await getPublishMetadata(accessToken, url);
            if (publishStatus === 404) {
                await requestIndexing(accessToken, url);
                console.log(
                    '🚀 Indexing requested successfully. It may take a few days for Google to process it.',
                );
            } else if (publishStatus < 400) {
                console.log(
                    '🕛 Indexing already requested previously. It may take a few days for Google to process it.',
                );
            }
            console.log('');
        }
    },
    pages,
    10,
    (batchIndex, batchCount) => {
        console.log(`📦 Batch ${batchIndex + 1} of ${batchCount} complete`);

        writeFileSync(cachePath, JSON.stringify(statusPerUrl, null, 2));
    },
);

////////////////////////////////////////////

console.log('');
console.log(`👍 Done, here's the status of all ${pages.length} pages:`);
writeFileSync(cachePath, JSON.stringify(statusPerUrl, null, 2));

for (const [status, pages] of Object.entries(pagesPerStatus)) {
    console.log(`• ${getEmojiForStatus(status)} ${status}: ${pages.length} pages`);
}
console.log('');

console.log('👍 All done!');
