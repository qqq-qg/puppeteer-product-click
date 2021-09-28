const puppeteer = require("puppeteer");
const proxyChain = require('proxy-chain');
const request = require('request')
const mysql = require('mysql');
const childProcess = require('child_process')
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: 'root',
    database: 'dms',
    port: 3306
});

const launchConf = {
    headless: false,
    // devtools: true,
    defaultViewport: null,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ignoreHTTPSErrors: true,
};

var pageOption = {timeout: 60000, waitUntil: 'domcontentloaded'};

var browser, page
var row
var shop, host
var sliding = false;
const getTaskSql = 'select * from `pms_view_task` where `status` = 0 and `finished` = 0 and `expect_vn` > `view_vn` order by `id` asc limit 1';
var running = false;
// start
(async () => {
    let i = 1;
    let s = 10;
    console.log('------------------------------');
    console.log('start...\t' + i++);
    await start()
    console.log('end!,pls wait...\n------------------------------');
    setInterval(async function () {
        if (!running) {
            console.log('start...\t' + i++);
            await start()
            console.log('end!,pls wait...\n------------------------------');
        }
    }, s * 1000);
})();

async function start() {
    running = true;
    try {
        let rows = await synchronous_sql(getTaskSql)
        if (rows.length === 0) {
            console.log('No found available task');
            // process.exit(0);
        } else {
            row = rows[0];
            let newLaunchConf = Object.assign({}, launchConf);
            let proxy_pool = await get_available_proxy();
            if (!proxy_pool) {
                console.log('获取代理IP异常，无法获取有效IP');
            } else {
                let newProxyUrl = await proxyChain.anonymizeProxy(proxy_pool);
                newLaunchConf.args = ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized', '--proxy-server=' + newProxyUrl];
                console.log('应用代理:' + newProxyUrl);
                browser = await puppeteer.launch(newLaunchConf);
                await browser.userAgent(user_agent());
                page = await browser.newPage();
                await page.evaluateOnNewDocument(() => {
                    const newProto = navigator.__proto__;
                    delete newProto.webdriver;
                    navigator.__proto__ = newProto;
                });

                let uptRes = await synchronous_sql('update `pms_view_task` set `status` = ? where `id` = ?', [1, row.id]);
                if (uptRes.affectedRows === uptRes.changedRows) {
                    if (row.platform === 'shopee') {
                        await query_product(page, row);
                    } else {
                        await query_product_lazada(page, row);
                    }
                }
                console.log('SUCCESS');
            }
        }
    } catch (e) {
        if (row) {
            await synchronous_sql('update `pms_view_task` set `status` = ? where `id` = ?', [0, row.id]);
        }
        console.log('ERROR', '\r\n', e.message);
    }
    if (page) {
        await page.close();
        page = false;
    }
    if (browser) {
        await browser.close();
        browser = false;

        //强制关闭chrome进程 --window
        childProcess.exec('wmic process where "name=\'chrome.exe\' and executablepath like \'%puppeteer%\'" delete');
    }
    console.log('process finished !');
    running = false;
}

//shopee
async function query_product(page, row) {
    await page.goto(row.link, pageOption);
    await page.waitForTimeout(1000);
    host = (new URL(row.link)).origin;

    //选择英语
    let modalShow = await is_show(page, '#modal .language-selection');
    if (modalShow) {
        await page.click('#modal .shopee-button-outline');
        await page.waitForTimeout(300);
    }

    await page.waitForSelector('.attM6y')
    let title = await page.$eval('.attM6y', el => el.textContent || '');
    await page.waitForSelector('.page-product__shop')
    shop = await get_shop_info(page);

    //更新标题 ，店铺名称
    await synchronous_sql('update `pms_view_task` set `step`=?,`title`=?,`shop_name`=? where `id`=?', [1, title, shop.name, row.id]);

    try {
        console.log('跳转到网站首页:' + host);
        await page.goto(host, pageOption);
        await page.waitForTimeout(1000);

        //选择英语
        modalShow = await is_show(page, '#modal .language-selection');
        if (modalShow) {
            await page.click('.shopee-button-outline');
            await page.waitForTimeout(150);
        }

        await page.waitForSelector('input.shopee-searchbar-input__input');
        await page.type('input.shopee-searchbar-input__input', title);
        await page.waitForSelector('.shopee-searchbar button')
        await page.waitForTimeout(2000);

        //关闭弹框
        modalShow = await is_show(page, '#modal .shopee-popup__close-btn');
        if (modalShow) {
            await page.click('#modal .shopee-popup__close-btn');
            await page.waitForTimeout(1000);
        }

        console.log('输入标题进行搜索');
        await Promise.all([page.waitForNavigation(pageOption), page.click('.shopee-searchbar button'),]);
        await page.waitForTimeout(1000);
        await page.waitForSelector('.shopee-search-item-result__items');

        //页面滚动到底部
        await auto_scroll(page);
        await page.waitForTimeout(1000);
        let itemsData = await page.$$eval('.shopee-search-item-result__items>.shopee-search-item-result__item',
            (els, host) => els.map(function (el) {
                let title = '';
                let div = el.querySelector('a>div:first-child>div:first-child');
                if (div) {
                    div = div.children[1] || false;
                    if (div) {
                        title = div.querySelector('div:first-child>div:first-child>div:first-child').textContent || '';
                    }
                }
                let href = el.querySelector('a') ? el.querySelector('a').getAttribute('href') : '';
                return {title: title, href: host + href,}
            }), host);
        let matchRes = [];
        let oIdxArr = [];
        itemsData.forEach(function (item, i) {
            if (item.title === title) {
                matchRes.push({href: item.href, title: item.title, item_index: i});
            } else {
                oIdxArr.push(i);
            }
        });
        console.log('标题搜索结果:' + matchRes.length + '/' + itemsData.length);
        if (matchRes.length === 0) {
            throw new Error("未找到标题搜索结果");
        }
        if (oIdxArr.length) {
            //首位随机插入别人的产品
            let rid = oIdxArr[Math.floor(Math.random() * oIdxArr.length)];
            matchRes.unshift({href: itemsData[rid].href || '', title: itemsData[rid].title || '', item_index: rid});
        }
        for (let i = 0; i < matchRes.length; i++) {
            let idx = matchRes[i].item_index + 1;
            let eSel = '.shopee-search-item-result__item:nth-child(' + idx + ')'
            let productEle = await page.$(eSel);
            let box = await productEle.boundingBox();
            let x = Math.floor(box.x + box.width / 2);
            let y = Math.floor(box.y + box.height / 2);
            await page.waitForTimeout(200);
            await page.mouse.move(x, y, {steps: 5});
            await Promise.all([page.waitForNavigation(pageOption), page.click(eSel + '>a')]);
            await page.waitForTimeout(500);
            await page.waitForSelector('.page-product__shop');
            let prodShop = await get_shop_info(page);
            if (prodShop.name === shop.name) {
                console.log("命中目标店铺")
                await synchronous_sql('update `pms_view_task` set `step`=? where `id`=?', [2, row.id]);
                await page.waitForTimeout(2000 + parseInt(Math.random() * 1000));
                await auto_scroll(page, 200);
                await page.waitForSelector('.page-product__shop');
                await Promise.all([page.waitForNavigation(pageOption), page.click('.page-product__shop>div:first-child>div>div>a')]);
                console.log("进入店铺主页，随机浏览几个商品")
                await view_shop(page);
                break;
            } else {
                console.log("未命中，返回搜索页，尝试其他结果")
                await Promise.all([page.waitForNavigation(pageOption), page.goBack(pageOption)]);
                await page.waitForTimeout(1000);
                await page.waitForSelector('.shopee-search-item-result__items');
            }
        }
    } catch (e) {
        console.log(e.message);
        await synchronous_sql('update `pms_view_task` set `status`=? where `id`=?', [0, row.id]);
    }
}

async function view_shop(page) {
    await page.waitForTimeout(1000);
    await auto_scroll(page, 200);
    await page.waitForSelector('.shop-search-result-view .shop-search-result-view__item');
    let len = await page.$$eval('.shop-search-result-view .shop-search-result-view__item', els => els.length);
    let viewProductIndexArr = get_random_index(len, Math.min(Math.floor(len / 2), 3));
    console.log(len, viewProductIndexArr);
    let vpl = viewProductIndexArr.length;
    for (let i = 0; i < vpl; i++) {
        let idx = viewProductIndexArr[i];
        console.log('随机下标', idx);
        let bthSel = '.shop-search-result-view>.row>.shop-search-result-view__item:nth-child(' + (idx + 1) + ') a';
        await page.waitForSelector(bthSel);
        await Promise.all([page.waitForNavigation(pageOption), page.click(bthSel)]);
        await page.waitForTimeout(500);
        await page.waitForSelector('.attM6y');
        await auto_scroll(page, 100);
        await page.waitForTimeout(1500);

        if (i < vpl - 1) {
            await Promise.all([page.waitForNavigation(pageOption), page.goBack(pageOption)]);
            await page.waitForTimeout(1000);
            await page.waitForSelector('.shop-search-result-view');
        }
    }
    if (vpl) {
        if (row.expect_vn - row.view_vn === 1) {
            await synchronous_sql('update `pms_view_task` set `status`=?,`step`=?,`view_vn`=`view_vn`+1,`finished`=? where `id`=?', [0, 3, 1, row.id]);
        } else {
            await synchronous_sql('update `pms_view_task` set `status`=?,`step`=?,`view_vn`=`view_vn`+1 where `id`=?', [0, 3, row.id]);
        }
    } else {
        await synchronous_sql('update `pms_view_task` set `status`=? where `id`=?', [0, row.id]);
    }
}

async function get_shop_info(page) {
    return await page.$eval('.page-product__shop', (el, host) => {
        let name = '';
        let div = el.querySelector('div');
        if (div) {
            div = div.children[1] || false;
            if (div) {
                name = div.querySelector('div').textContent || '';
            }
        }
        let href = el.querySelector('.btn-light--link').getAttribute('href') || ''
        return {name: name, href: host + href,}
    }, host);
}

//lazada
async function query_product_lazada(page, row) {
    await page.goto(row.link, pageOption);
    await page.waitForTimeout(1000);
    await loop_watch_lazada_slide();

    let modalShow = await is_show(page, '.opened');
    if (modalShow) {
        await page.click('.opened .next-icon-close');
        await page.waitForTimeout(200);
    }

    await page.waitForSelector('.lzd-logo-content a')
    let hostUrl = await page.$eval('.lzd-logo-content a', el => el.getAttribute('href') || '');
    hostUrl = hostUrl.indexOf('//') === 0 ? 'https:' + hostUrl : hostUrl;
    host = (new URL(hostUrl)).origin;

    await page.waitForSelector('.pdp-mod-product-badge-title')
    let title = await page.$eval('.pdp-mod-product-badge-title', el => el.textContent || '');
    shop = await get_shop_info_lazada(page)

    //更新标题 ，店铺名称
    await synchronous_sql('update `pms_view_task` set `step`=?,`title`=?,`shop_name`=? where `id`=?', [1, title, shop.name, row.id]);
    try {
        console.log('跳转到网站首页:' + host);
        await page.goto(host, pageOption);
        await page.waitForTimeout(1000);
        await page.waitForSelector('.lzd-nav-search input');
        await page.type('.lzd-nav-search input', title);
        await page.waitForSelector('.lzd-nav-search button')
        await page.waitForTimeout(2000);
        console.log('输入标题进行搜索');
        await watch_lazada_slide();
        await Promise.all([page.waitForNavigation(pageOption), page.click('.lzd-nav-search button'),]);
        await watch_lazada_slide();
        await page.waitForTimeout(500);
        await page.waitForSelector('.ant-row .ant-col-push-4');

        //页面滚动到底部
        await auto_scroll(page);
        await page.waitForTimeout(500);
        let itemsData = await page.$$eval('.ant-row .ant-col-push-4>div:nth-child(2)>div',
            els => els.map(function (el) {
                let title = '';
                let href = '';
                let a = el.querySelector('div:first-child>div:nth-child(2)>div:nth-child(2) a');
                if (a) {
                    title = a.textContent || '';
                    href = a.getAttribute('href') || '';
                    if (href.indexOf('//') === 0) {
                        href = 'https:' + href;
                    }
                }
                return {title: title, href: href}
            }));
        let matchRes = [];
        let oIdxArr = [];
        itemsData.forEach(function (item, i) {
            if (item.title === title) {
                matchRes.push({href: item.href, title: item.title, item_index: i});
            } else {
                oIdxArr.push(i);
            }
        });
        console.log('标题搜索结果:' + matchRes.length + '/' + itemsData.length);
        if (matchRes.length === 0) {
            throw new Error("未找到标题搜索结果");
        }
        if (oIdxArr.length) {
            //首位随机插入别人的产品
            let rid = oIdxArr[Math.floor(Math.random() * oIdxArr.length)];
            matchRes.unshift({href: itemsData[rid].href || '', title: itemsData[rid].title || '', item_index: rid});
        }
        for (let i = 0; i < matchRes.length; i++) {
            let idx = matchRes[i].item_index + 1;
            let eSel = '.ant-row .ant-col-push-4>div:nth-child(2)>div:nth-child(' + idx + ')'
            await page.waitForTimeout(200);
            await Promise.all([page.waitForNavigation(pageOption), page.click(eSel + ' a')]);
            await page.waitForTimeout(500);
            let modalShow = await is_show(page, '.opened');
            if (modalShow) {
                await page.click('.opened .next-icon-close');
                await page.waitForTimeout(200);
            }

            let prodShop = await get_shop_info_lazada(page)
            if (prodShop.name === shop.name) {
                console.log("命中目标店铺")
                await synchronous_sql('update `pms_view_task` set `step`=? where `id`=?', [2, row.id]);
                await page.waitForTimeout(2000 + parseInt(Math.random() * 1000));
                await auto_scroll(page, 200);

                await page.waitForSelector('.seller-name__detail-name');
                console.log("进入店铺主页，随机浏览几个商品")
                await Promise.all([page.waitForNavigation(pageOption), page.click('.seller-name__detail-name')]);
                await view_shop_lazada(page);
                break;
            } else {
                console.log("未命中，返回搜索页，尝试其他结果")
                await Promise.all([page.waitForNavigation(pageOption), page.goBack(pageOption)]);
                await page.waitForTimeout(1000);
                await page.waitForSelector('.ant-row .ant-col-push-4');
            }
        }
    } catch (e) {
        console.log(e.message);
        await synchronous_sql('update `pms_view_task` set `status`=? where `id`=?', [0, row.id]);
    }
}

async function get_shop_info_lazada(page) {
    await page.waitForSelector('.seller-name__detail-name')
    return await page.$eval('.seller-name__detail-name', el => {
        let href = el.getAttribute('href') || '';
        if (href.indexOf('//') === 0) {
            href = 'https:' + href;
        }
        return {name: el.textContent || '', href: href}
    });
}

async function view_shop_lazada(page) {
    await page.waitForTimeout(1000);
    await watch_lazada_slide();
    await auto_scroll(page, 200);
    let itemsSel = 'list-items';
    await page.waitForSelector('div[data-exp-justforyou]');
    await page.evaluate((itemsSel) => {
        let itemsEle = document.querySelector('[data-exp-justforyou]').parentNode;
        itemsEle.className = itemsEle.className + ' ' + itemsSel;
        return itemsSel;
    }, itemsSel);
    let len = await page.$$eval('.' + itemsSel + '>div', els => els.length);
    let viewProductIndexArr = get_random_index(len, Math.min(Math.floor(len / 2), 3));
    console.log(len, viewProductIndexArr);
    let vpl = viewProductIndexArr.length;
    for (let i = 0; i < vpl; i++) {
        let idx = viewProductIndexArr[i];
        let bthSel = '.' + itemsSel + '>div:nth-child(' + (idx + 1) + ') a';
        let btnEle = await page.$(bthSel);
        if (!btnEle) {
            continue;
        }
        console.log('随机下标', idx);
        //进入详情浏览
        await page.waitForSelector(bthSel);
        await Promise.all([page.waitForNavigation(pageOption), page.click(bthSel)]);
        await watch_lazada_slide();
        await page.waitForTimeout(500);
        await page.waitForSelector('.seller-name__detail-name');
        await auto_scroll(page, 100);
        await page.waitForTimeout(1000);

        if (i < vpl - 1) {
            //返回店铺主页
            console.log('返回店铺主页');
            await Promise.all([page.waitForNavigation(pageOption), page.goBack(pageOption)]);
            await watch_lazada_slide();
            await page.waitForTimeout(1000);
            await page.waitForSelector('div[data-exp-justforyou]');
            await page.evaluate((itemsSel) => {
                let itemsEle = document.querySelector('[data-exp-justforyou]').parentNode;
                itemsEle.className = itemsEle.className + ' ' + itemsSel;
                return itemsSel;
            }, itemsSel);
            await page.waitForTimeout(200);
        }
    }
    if (vpl) {
        await synchronous_sql('update `pms_view_task` set `status`=?,`step`=?,`view_vn`=`view_vn`+1 where `id`=?', [0, 3, row.id]);
    } else {
        await synchronous_sql('update `pms_view_task` set `status`=? where `id`=?', [0, row.id]);
    }
}

async function watch_lazada_slide() {
    if (!page) {
        return true;
    }
    if (sliding) {
        return true;
    }
    sliding = true;
    let btnSlide = await page.$('#nc_2_n1z');
    if (btnSlide) {
        let btnSlide = await page.$('#nc_2_n1z');
        let box = await btnSlide.boundingBox();
        let x = Math.floor(box.x + box.width / 2);
        let y = Math.floor(box.y + box.height / 2);
        let nc_1_n1t = await page.$('#nc_2__scale_text');
        let disBox = await nc_1_n1t.boundingBox();
        let dis = disBox.width - box.width;
        let r = await try_lazada_slide(page, {x: x, y: y, dis: dis}, 3);
        sliding = false;
        return r;
    } else {
        let frames = await page.frames();
        let frame;
        for (let i = 0; i < frames.length; i++) {
            if (await frames[i].$('#nc_2_n1z')) {
                frame = frames[i];
            }
        }
        let bd = await is_show(page, '.baxia-dialog');
        let jmfw = await is_show(page, '.J_MIDDLEWARE_FRAME_WIDGET');
        if (frame && (bd || jmfw)) {
            let btnSlide = await frame.$('#nc_2_n1z');
            let box = await btnSlide.boundingBox();
            let x = Math.floor(box.x + box.width / 2);
            let y = Math.floor(box.y + box.height / 2);
            let nc_1_n1t = await frame.$('#nc_2__scale_text');
            let disBox = await nc_1_n1t.boundingBox();
            let dis = disBox.width - box.width;
            let r = await try_lazada_slide(page, {x: x, y: y, dis: dis}, 3);
            sliding = false;
            return r;
        }
    }
    sliding = false;
    return true;
}

async function loop_watch_lazada_slide() {
    var inv = setInterval(async function () {
        if (!sliding) {
            try {
                await watch_lazada_slide();
            } catch (e) {
            }
        }
    }, 10000);
}

async function try_lazada_slide(page, opt, times = 1) {
    let x = parseInt(opt.x), y = parseInt(opt.y), dis = parseInt(opt.dis), n = 20;
    await page.waitForTimeout(1000);
    await page.mouse.move(x, y, {steps: random_num(5, 15)});
    await page.waitForTimeout(2000);
    await page.mouse.down();
    for (let i = 1; i < n; i++) {
        await page.mouse.move(parseInt(x + Math.floor(dis * i / n) + random_num(-2, 2)), parseInt(y + random_num(-2, 2)), {steps: random_num(5, 15)});
    }
    await page.mouse.move(parseInt(x + dis), y, {steps: random_num(5, 15)});
    await page.mouse.up();
    await page.waitForTimeout(500);
    // let again = await page.$('#nc_2_n1z');
    // if (again && times-- > 0) {
    //     await try_lazada_slide(page, opt, times);
    // }
    return true;
}

//common function
// 同步休眠函数 - 微秒 eg.2000
function sleep(delay) {
    let st = (new Date()).getTime();
    while ((new Date()).getTime() - st < delay) {
    }
}

function dateFormat(timestamp, formats) {
    // formats格式包括
    // 1. Y-m-d
    // 2. Y-m-d H:i:s
    // 3. Y年m月d日
    // 4. Y年m月d日 H时i分
    formats = formats || 'Y-m-d';
    let zero = function (value) {
        if (value < 10) {
            return '0' + value;
        }
        return value;
    };
    let myDate = timestamp ? new Date(parseInt(timestamp) * 1000) : new Date();
    let year = myDate.getFullYear();
    let month = zero(myDate.getMonth() + 1);
    let day = zero(myDate.getDate());
    let hour = zero(myDate.getHours());
    let minite = zero(myDate.getMinutes());
    let second = zero(myDate.getSeconds());
    return formats.replace(/Y|m|d|H|i|s/ig, function (matches) {
        return ({
            Y: year,
            m: month,
            d: day,
            H: hour,
            i: minite,
            s: second
        })[matches];
    });
}

// 索引数组随机取N个元素
function get_random_index(len, n = 3) {
    n = Math.min(len, n);
    let r = [];
    while (n) {
        let k = Math.floor(Math.random() * len);
        if (r.indexOf(k) === -1) {
            r.push(k)
            n--
        }
    }
    return r;
}

function random_num(minNum, maxNum) {
    return parseInt(Math.random() * (maxNum - minNum + 1) + minNum, 10);
}

async function is_show(page, eleSelector) {
    let modal = await page.$(eleSelector);
    return modal ? (await page.evaluate(obj => {
        let ret = obj.style.display === "none" ||
            (obj.currentStyle && obj.currentStyle === "none") ||
            (window.getComputedStyle && window.getComputedStyle(obj, null).display === "none");
        return !ret;
    }, modal)) : false;
}

async function auto_scroll(page, speed = 100) {
    return page.evaluate((speed) => {
        return new Promise((resolve) => {
            //滚动的总高度
            let totalHeight = 0;
            //每次向下滚动的高度 100 px
            let distance = 100;
            let timer = setInterval(() => {
                //页面的高度 包含滚动高度
                let scrollHeight = document.body.scrollHeight;
                //滚动条向下滚动 distance
                window.scrollBy(0, distance);
                totalHeight += distance;
                //当滚动的总高度 大于 页面高度 说明滚到底了。也就是说到滚动条滚到底时，以上还会继续累加，直到超过页面高度
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, speed);
        })
    }, speed);
}

async function user_agent() {
    let userAgents = [
        'Mozilla/5.0 (X11; U; Linux i686; en-US; rv:1.8.0.12) Gecko/20070731 Ubuntu/dapper-security Firefox/1.5.0.12',
        'Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.0; Acoo Browser; SLCC1; .NET CLR 2.0.50727; Media Center PC 5.0; .NET CLR 3.0.04506)',
        'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/535.11 (KHTML, like Gecko) Chrome/17.0.963.56 Safari/535.11',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_7_3) AppleWebKit/535.20 (KHTML, like Gecko) Chrome/19.0.1036.7 Safari/535.20',
        'Mozilla/5.0 (X11; U; Linux i686; en-US; rv:1.9.0.8) Gecko Fedora/1.9.0.8-1.fc10 Kazehakase/0.5.6',
        'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.1 (KHTML, like Gecko) Chrome/21.0.1180.71 Safari/537.1 LBBROWSER',
        'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Win64; x64; Trident/5.0; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET CLR 2.0.50727; Media Center PC 6.0) ,Lynx/2.8.5rel.1 libwww-FM/2.14 SSL-MM/1.4.1 GNUTLS/1.2.9',
        'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1; .NET CLR 1.1.4322; .NET CLR 2.0.50727)',
        'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; Media Center PC 6.0; .NET4.0C; .NET4.0E; QQBrowser/7.0.3698.400)',
        'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1; QQDownload 732; .NET4.0C; .NET4.0E)',
        'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:2.0b13pre) Gecko/20110307 Firefox/4.0b13pre',
        'Opera/9.80 (Macintosh; Intel Mac OS X 10.6.8; U; fr) Presto/2.9.168 Version/11.52',
        'Mozilla/5.0 (X11; U; Linux i686; en-US; rv:1.8.0.12) Gecko/20070731 Ubuntu/dapper-security Firefox/1.5.0.12',
        'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; Media Center PC 6.0; .NET4.0C; .NET4.0E; LBBROWSER)',
        'Mozilla/5.0 (X11; U; Linux i686; en-US; rv:1.9.0.8) Gecko Fedora/1.9.0.8-1.fc10 Kazehakase/0.5.6',
        'Mozilla/5.0 (X11; U; Linux; en-US) AppleWebKit/527+ (KHTML, like Gecko, Safari/419.3) Arora/0.6',
        'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; Media Center PC 6.0; .NET4.0C; .NET4.0E; QQBrowser/7.0.3698.400)',
        'Opera/9.25 (Windows NT 5.1; U; en), Lynx/2.8.5rel.1 libwww-FM/2.14 SSL-MM/1.4.1 GNUTLS/1.2.9',
        'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'
    ];
    let rid = parseInt(Math.random() * userAgents.length);
    return userAgents[rid];
}

async function synchronous_sql(sql, values) {
    // 返回一个 Promise
    return new Promise((resolve, reject) => {
        pool.getConnection(function (err, connection) {
            if (err) {
                reject(err)
            } else {
                connection.query(sql, values, (err, rows) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(rows)
                    }
                    // 结束会话
                    connection.release()
                })
            }
        })
    })
}

async function synchronous_request(url, proxy = '') {
    return new Promise(function (resolve, reject) {
        request.get({url: url, proxy: proxy}, function (error, response, body) {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });
    });
}

//获取代理IP
async function get_available_proxy() {
    let ret = '';//http://127.0.0.1:1080
    return ret;
}
