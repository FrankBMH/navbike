import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getKey, looksLikeKey, maskKey, saveKey, verifyKey } from './config';

type Props = {
  /** 保存成功后回调 */
  onDone: () => void;
  /** 有值表示这是「修改」而不是「首次配置」，会显示返回按钮 */
  onCancel?: () => void;
};

export default function KeyGate({ onDone, onCancel }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  const cur = getKey();

  async function submit() {
    const k = text.trim();
    if (!looksLikeKey(k)) {
      setErr('高德 Web 服务 Key 是 32 位十六进制字符（只含 0-9 和 a-f），请检查是否少复制了一段');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const bad = await verifyKey(k);
      if (bad) {
        setErr(bad);
        return;
      }
      await saveKey(k);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {onCancel && (
          <Pressable style={styles.backRow} onPress={onCancel} hitSlop={10}>
            <Text style={styles.back}>‹ 返回</Text>
          </Pressable>
        )}

        <Text style={styles.title}>配置高德密钥</Text>
        <Text style={styles.sub}>
          这个 App 不含任何内置 Key，路线和地点搜索都走你自己的高德账号。
          配额是你自己的，不会被别人用掉。
        </Text>

        {!!cur && <Text style={styles.cur}>当前：{maskKey(cur)}　粘贴新的会覆盖</Text>}

        <TextInput
          style={styles.input}
          value={text}
          onChangeText={t => {
            setText(t);
            setErr('');
          }}
          placeholder="粘贴 32 位 Key"
          placeholderTextColor="#aaa"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!busy}
        />

        <Pressable
          style={[styles.btn, (!text.trim() || busy) && styles.btnOff]}
          onPress={submit}
          disabled={!text.trim() || busy}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>验证并保存</Text>}
        </Pressable>

        {!!err && <Text style={styles.err}>{err}</Text>}

        <Pressable onPress={() => setShowHelp(v => !v)} hitSlop={8} style={styles.helpToggle}>
          <Text style={styles.link}>{showHelp ? '收起申请步骤' : '还没有 Key？看申请步骤'}</Text>
        </Pressable>

        {showHelp && (
          <View style={styles.help}>
            <Text style={styles.helpTitle}>5 分钟拿到一个 Key</Text>
            {[
              '浏览器打开 console.amap.com，用高德账号登录（没有就注册，个人开发者免费）',
              '左侧「应用管理」→「我的应用」→ 右上「创建新应用」，名字随便填',
              '进入应用点「添加 Key」：名称随便填，服务平台必须选「Web服务」',
              '创建完复制那串 32 位字符，回到这里粘贴',
            ].map((s, i) => (
              <Text key={i} style={styles.helpItem}>
                {i + 1}. {s}
              </Text>
            ))}
            <Text style={styles.helpNote}>
              服务平台选错是最常见的失败原因：选「Web端(JS API)」或「iOS」都会报 Key 平台不符。
            </Text>
          </View>
        )}

        <Text style={styles.foot}>
          Key 只保存在这台手机本地，不写进安装包，也不上传到任何服务器。
          换手机或删掉重装 App 时需要重新填一次。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FAF9F5' },
  body: { padding: 22, paddingTop: 70, paddingBottom: 40 },
  backRow: { marginBottom: 10 },
  back: { fontSize: 15, color: '#185FA5' },
  title: { fontSize: 24, fontWeight: '700', color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#6b6b66', lineHeight: 20, marginTop: 10 },
  cur: { fontSize: 12, color: '#993C1D', marginTop: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#D8D4C8',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: '#1a1a1a',
    backgroundColor: '#fff',
    marginTop: 16,
  },
  btn: {
    backgroundColor: '#185FA5',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  btnOff: { backgroundColor: '#B9C6D2' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  err: { color: '#C0392B', fontSize: 13, lineHeight: 19, marginTop: 12 },
  helpToggle: { marginTop: 22, alignSelf: 'flex-start' },
  link: { fontSize: 13, color: '#185FA5' },
  help: {
    marginTop: 10,
    padding: 14,
    backgroundColor: '#F1F0EA',
    borderRadius: 10,
  },
  helpTitle: { fontSize: 13, fontWeight: '600', color: '#1a1a1a', marginBottom: 8 },
  helpItem: { fontSize: 12.5, color: '#4a4a45', lineHeight: 21 },
  helpNote: { fontSize: 12, color: '#993C1D', lineHeight: 18, marginTop: 10 },
  foot: { fontSize: 11.5, color: '#9a9a93', lineHeight: 18, marginTop: 26 },
});
