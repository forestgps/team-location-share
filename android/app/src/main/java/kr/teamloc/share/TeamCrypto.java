package kr.teamloc.share;

import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.spec.KeySpec;
import java.util.Arrays;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 웹(crypto-team.js)과 완전히 동일한 방식으로 팀 키를 유도하고 메시지를 암호화한다.
 *
 * 하나라도 어긋나면 웹 화면과 네이티브 서비스가 서로 다른 토픽에 붙거나 복호화에 실패하므로,
 * 아래 상수와 절차는 crypto-team.js 와 반드시 같아야 한다.
 *
 *   salt        = "rtloc/v2|team|" + 정규화한 팀 이름(공백 정리 + 소문자)
 *   유도        = PBKDF2-HMAC-SHA256, 200,000회, 512비트
 *   앞 256비트  = AES-GCM 키
 *   뒤 256비트  = 토픽 이름 (hex 앞 32자)
 *   봉투        = {"v":2,"iv":base64(12바이트),"ct":base64(암호문+태그)}
 */
final class TeamCrypto {

    static final String TOPIC_PREFIX = "rtloc/v2";
    private static final int ITERATIONS = 200000;
    private static final int DERIVED_BITS = 512;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKey aesKey;
    private final String topic;

    private TeamCrypto(SecretKey aesKey, String topic) {
        this.aesKey = aesKey;
        this.topic = topic;
    }

    String topic() {
        return topic;
    }

    static TeamCrypto derive(String teamName, String secret) throws Exception {
        String normalized = teamName.trim().replaceAll("\\s+", " ").toLowerCase(new Locale("ko"));
        byte[] salt = (TOPIC_PREFIX + "|team|" + normalized).getBytes(StandardCharsets.UTF_8);

        KeySpec spec = new PBEKeySpec(secret.toCharArray(), salt, ITERATIONS, DERIVED_BITS);
        SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        byte[] bits = factory.generateSecret(spec).getEncoded();

        byte[] keyBytes = Arrays.copyOfRange(bits, 0, 32);
        byte[] topicBytes = Arrays.copyOfRange(bits, 32, 64);
        Arrays.fill(bits, (byte) 0);

        String topicId = toHex(topicBytes).substring(0, 32);
        return new TeamCrypto(new SecretKeySpec(keyBytes, "AES"), TOPIC_PREFIX + "/" + topicId);
    }

    /** JSON 문자열을 암호화해 전송용 봉투 문자열로 만든다. */
    String encrypt(String plainJson) throws Exception {
        byte[] iv = new byte[IV_BYTES];
        new java.security.SecureRandom().nextBytes(iv);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, aesKey, new GCMParameterSpec(TAG_BITS, iv));
        byte[] cipherText = cipher.doFinal(plainJson.getBytes(StandardCharsets.UTF_8));

        return "{\"v\":2,\"iv\":\"" + base64(iv) + "\",\"ct\":\"" + base64(cipherText) + "\"}";
    }

    /**
     * 봉투 문자열을 복호화한다. 팀 암호가 다르면 예외가 난다.
     * 웹의 RtlocCrypto.decrypt 와 같은 형식을 다룬다.
     */
    String decrypt(String envelope) throws Exception {
        String iv = extract(envelope, "iv");
        String ct = extract(envelope, "ct");
        if (iv == null || ct == null) throw new IllegalArgumentException("bad envelope");

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, aesKey,
                new GCMParameterSpec(TAG_BITS, Base64.decode(iv, Base64.DEFAULT)));
        byte[] plain = cipher.doFinal(Base64.decode(ct, Base64.DEFAULT));
        return new String(plain, StandardCharsets.UTF_8);
    }

    /**
     * 아주 단순한 JSON 문자열 값 추출기.
     * 봉투와 메시지 모두 우리가 만든 평평한 구조라서 정식 파서를 붙이지 않는다.
     */
    static String extract(String json, String key) {
        String needle = "\"" + key + "\"";
        int at = json.indexOf(needle);
        if (at < 0) return null;

        int colon = json.indexOf(':', at + needle.length());
        if (colon < 0) return null;

        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length()) return null;

        if (json.charAt(i) == '"') {
            StringBuilder sb = new StringBuilder();
            i++;
            while (i < json.length()) {
                char c = json.charAt(i);
                if (c == '\\' && i + 1 < json.length()) {
                    char next = json.charAt(i + 1);
                    if (next == 'n') sb.append('\n');
                    else if (next == 't') sb.append('\t');
                    else if (next == 'u' && i + 5 < json.length()) {
                        sb.append((char) Integer.parseInt(json.substring(i + 2, i + 6), 16));
                        i += 4;
                    } else sb.append(next);
                    i += 2;
                    continue;
                }
                if (c == '"') break;
                sb.append(c);
                i++;
            }
            return sb.toString();
        }

        int end = i;
        while (end < json.length() && ",}]".indexOf(json.charAt(end)) < 0) end++;
        return json.substring(i, end).trim();
    }

    private static String base64(byte[] data) {
        return Base64.encodeToString(data, Base64.NO_WRAP);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
