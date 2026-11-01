import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

/** Reuse an installed browser when bundled Chromium has not been downloaded. */
export function launchSmokeBrowser(){
 const executable=process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || (!process.env.PLAYWRIGHT_CHANNEL&&!existsSync(chromium.executablePath())?[
   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/usr/bin/google-chrome','/usr/bin/chromium',
  ].find(path=>existsSync(path)):undefined);
 return chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),
  ...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
}
