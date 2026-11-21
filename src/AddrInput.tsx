import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export type Picked = { name: string; location: string; district: string };

type Props = {
  value: string;
  onChangeText: (t: string) => void;
  onPick: (p: Picked) => void;
  placeholder: string;
  apiKey: string;
  city?: string;
};

export default function AddrInput({ value, onChangeText, onPick, placeholder, apiKey, city }: Props) {
  const [tips, setTips] = useState<Picked[]>([]);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (value.trim().length < 2) { setTips([]); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const cityPart = city ? `&city=${encodeURIComponent(city)}&citylimit=true` : '';
        const u = `https://restapi.amap.com/v3/assistant/inputtips?keywords=${encodeURIComponent(value)}${cityPart}&key=${apiKey}`;
        const j = await (await fetch(u)).json();
        if (String(j.status) !== '1') return;
        setTips(
          (j.tips || [])
            .filter((t: any) => typeof t.location === 'string' && t.location.includes(','))
            .slice(0, 6)
            .map((t: any) => ({ name: t.name, location: t.location, district: t.district || '' })),
        );
      } catch {}
    }, 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, city, apiKey]);

  return (
    <View style={{ marginBottom: 8 }}>
      <TextInput style={styles.input} value={value} onChangeText={onChangeText} placeholder={placeholder} />
      {tips.length > 0 && (
        <View style={styles.tips}>
          {tips.map((t, i) => (
            <Pressable key={i} style={styles.tip} onPress={() => { onPick(t); setTips([]); }}>
              <Text style={styles.tipName}>{t.name}</Text>
              <Text style={styles.tipSub}>{t.district}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 15 },
  tips: { borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginTop: 4, backgroundColor: '#fff' },
  tip: { paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#f2f2f2' },
  tipName: { fontSize: 14, color: '#111' },
  tipSub: { fontSize: 12, color: '#999', marginTop: 1 },
});
