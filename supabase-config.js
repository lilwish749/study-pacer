/*
 * Supabase 配置
 * 在 Supabase 控制台：Project Settings → API 中找到两项，填到下面：
 *   url     = Project URL（形如 https://xxxxxxxx.supabase.co）
 *   anonKey = anon public key（可公开的前端密钥）
 * 注意：绝对不要把 service_role key 写进这个文件。
 * 填好后保存，刷新 index.html 即可使用登录/注册。
 */
window.STUDY_PACER_SUPABASE = {
  url: 'https://akzkrsddwrszizqxdxel.supabase.co',
  anonKey: 'sb_publishable_jVrq_S-wFJmLRtcVMb1QsA__M3eDpzP'
};
