/**
 * 完整测试：模拟扩展的两次发送场景
 * 1. 第一次发送 - 获取 toolplan
 * 2. 第二次发送 - 获取 diff
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

async function getMessageCount(page) {
  const messages = page.locator('.ds-message, [class*="ds-message"]');
  return await messages.count();
}

async function getLastMessageText(page) {
  const messages = page.locator('.ds-message, [class*="ds-message"]');
  const count = await messages.count();
  if (count === 0) return '';
  return await messages.last().innerText().catch(() => '');
}

async function getFullPageText(page) {
  return await page.evaluate(() => {
    const root = document.getElementById('root') || document.body;
    return root.innerText || '';
  });
}

async function sendAndWaitForReply(page, message, debug = true) {
  if (debug) console.log(`\n📤 发送: "${message.slice(0, 50)}..."`);
  
  const beforeCount = await getMessageCount(page);
  const beforeText = await getFullPageText(page);
  if (debug) console.log(`📊 发送前消息数: ${beforeCount}, 页面文本: ${beforeText.length} 字符`);
  
  // 发送消息
  const input = page.locator('textarea').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.click();
  await input.fill(message);
  await page.waitForTimeout(300);
  await input.press('Enter');
  
  // 等待新消息出现
  if (debug) console.log('⏳ 等待新消息...');
  const startTime = Date.now();
  let newCount = beforeCount;
  
  while (Date.now() - startTime < 30000) {
    newCount = await getMessageCount(page);
    if (newCount > beforeCount) {
      if (debug) console.log(`✅ 新消息出现: ${beforeCount} -> ${newCount}`);
      break;
    }
    await page.waitForTimeout(500);
  }
  
  // 等待内容稳定
  if (debug) console.log('⏳ 等待内容稳定...');
  let lastText = '';
  let stableCount = 0;
  const start2 = Date.now();
  
  while (Date.now() - start2 < 60000) {
    const currentText = await getLastMessageText(page);
    
    if (currentText !== lastText) {
      lastText = currentText;
      stableCount = 0;
      if (debug && lastText.length > 0) {
        console.log(`📈 内容更新: ${lastText.length} 字符`);
      }
    } else {
      stableCount++;
    }
    
    if (stableCount >= 3 && lastText.length > 0) {
      if (debug) console.log('✅ 内容稳定');
      break;
    }
    
    await page.waitForTimeout(800);
  }
  
  return lastText;
}

async function main() {
  console.log('🚀 启动 Playwright...');
  
  const userDataDir = path.join(os.homedir(), '.deepseek-test-profile');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false
  });
  
  const page = await context.newPage();
  
  console.log('📄 打开 DeepSeek...');
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  
  // ============ 第一次发送：请求 toolplan ============
  console.log('\n' + '='.repeat(50));
  console.log('第一次发送：请求 toolplan');
  console.log('='.repeat(50));
  
  const prompt1 = `你是一个代码助手。请基于以下上下文修改我的 VSCode 工作区代码。
强约束：你的输出只能是以下三种之一，且只能输出其中一种（不要输出任何解释/前后缀/标语/复述提示词）：
A) 一个 \`\`\`toolcall\`\`\` 代码块
B) 一个 \`\`\`toolplan\`\`\` 代码块
C) 一个 unified diff 补丁

用户需求：你好

请先输出一个工具计划（toolplan），只输出一个代码块，不要输出其它文字。`;

  const reply1 = await sendAndWaitForReply(page, prompt1);
  
  console.log('\n📋 第一次回复内容:');
  console.log('---');
  console.log(reply1.slice(0, 800));
  console.log('---');
  
  // 检查是否包含 toolplan
  const hasToolplan = reply1.includes('toolplan') || reply1.includes('"read"');
  console.log(`\n🎯 包含 toolplan: ${hasToolplan ? '✅ 是' : '❌ 否'}`);
  
  // ============ 第二次发送：请求 diff ============
  console.log('\n' + '='.repeat(50));
  console.log('第二次发送：请求 diff');
  console.log('='.repeat(50));
  
  await page.waitForTimeout(2000); // 等待一下
  
  const prompt2 = `你已给出 toolplan 且我已按计划读取了文件（见上下文片段）。
现在请直接输出 unified diff（以 diff --git 开头），不要输出任何解释。

文件内容：
# package.json
{"name": "test-project", "version": "1.0.0"}

用户需求：添加一个 description 字段，值为 "A test project"`;

  const reply2 = await sendAndWaitForReply(page, prompt2);
  
  console.log('\n📋 第二次回复内容:');
  console.log('---');
  console.log(reply2.slice(0, 800));
  console.log('---');
  
  // 检查是否包含 diff
  const hasDiff = reply2.includes('diff --git') || reply2.includes('---') || reply2.includes('+++');
  console.log(`\n🎯 包含 diff: ${hasDiff ? '✅ 是' : '❌ 否'}`);
  
  // 检查是否只是 UI 噪音
  const isNoise = reply2.trim() === 'DeepThink\nSearch\nAI-generated, for reference only' ||
                  reply2.length < 50;
  console.log(`🎯 是 UI 噪音: ${isNoise ? '❌ 是（问题！）' : '✅ 否'}`);
  
  // ============ 分析问题 ============
  console.log('\n' + '='.repeat(50));
  console.log('问题分析');
  console.log('='.repeat(50));
  
  // 获取整页文本，看看实际内容是什么
  const fullText = await getFullPageText(page);
  console.log(`\n页面总文本: ${fullText.length} 字符`);
  console.log('\n页面尾部 1500 字符:');
  console.log('---');
  console.log(fullText.slice(-1500));
  console.log('---');
  
  console.log('\n⏳ 保持浏览器打开 30 秒...');
  await page.waitForTimeout(30000);
  
  await context.close();
  console.log('✅ 测试完成');
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
