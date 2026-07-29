# 팀 전용 브로커 설정

공개 브로커(broker.emqx.io 등)는 남의 자원이라 언제 끊길지, 첨부를 얼마나 보관해 줄지
보장이 없다. 팀 브로커를 쓰면 세 가지가 달라진다.

- 첨부가 정해진 기간 동안 확실히 보관된다(기본 30일, 값은 바꿀 수 있다)
- 6MB가 넘는 동영상도 보관된다(앱이 자체 브로커를 감지해 한도를 64MB로 올린다)
- 팀 채널이 공개 브로커에 남지 않는다. 아이디·암호를 가진 기기만 접속한다

위치와 메모는 원래도 기기에서 암호화되어 오간다. 브로커를 바꿔도 그 부분은 그대로다.

두 가지 길이 있다. **서버 관리를 하고 싶지 않으면 A**, 완전히 손에 쥐고 싶으면 B.

---

## A. EMQX Serverless (서버 관리 없음)

가입하면 TLS가 붙은 접속 주소와 아이디·암호를 바로 받는다. 무료 사용량이 있어
소규모 팀은 대개 비용이 들지 않는다.

1. https://www.emqx.com/en/cloud 에서 가입하고 **Serverless** 배포를 만든다
2. 지역은 팀이 있는 곳과 가까운 쪽(예: 서울/도쿄)을 고른다
3. **Authentication**에서 사용자 하나를 만든다 (예: 아이디 `forestgps`)
4. 배포 화면의 접속 정보에서 **WebSocket over TLS** 주소를 확인한다
   보통 `wss://xxxxxxxx.ala.asia-southeast1.emqxsl.com:8084/mqtt` 형태다
5. 아래 "앱에 넣기"로 간다

주의: 무료 등급은 보관(retained) 메시지 수와 트래픽에 한도가 있다. 사진 위주면
넉넉하지만, 동영상을 자주 올리면 한도를 확인하세요.

---

## B. 직접 서버에 올리기 (VPS + Docker)

준비물은 세 가지다.

- 리눅스 서버 하나 (RAM 1GB면 충분. 국내 클라우드나 Vultr/Hetzner 등 월 5달러대)
- 도메인 하나. 예: `mqtt.내도메인.com`
- 그 도메인의 A 레코드가 서버 IP를 가리키도록 설정 (DNS 전파까지 몇 분)

### 1. 서버에 Docker 설치

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 다시 로그인하면 sudo 없이 쓸 수 있다
```

### 2. 이 폴더를 서버로 복사

```bash
git clone https://github.com/forestgps/team-location-share.git
cd team-location-share/broker
cp .env.example .env
nano .env        # 도메인, 메일, 대시보드 암호를 채운다
```

### 3. 방화벽 열기

```bash
sudo ufw allow 80/tcp     # 인증서 발급용
sudo ufw allow 8084/tcp   # 앱이 접속할 포트
sudo ufw enable
```

### 4. 실행

```bash
docker compose up -d
docker compose logs -f caddy   # "certificate obtained" 가 보이면 인증서 발급 성공
```

### 5. 대원용 아이디 만들기

브로커는 익명 접속을 막아 두었으므로 아이디를 하나 만들어야 한다.

```bash
docker exec -it emqx emqx ctl admins add forestgps '아주-긴-무작위-암호'
```

위 명령이 EMQX 버전에 따라 다르면 대시보드에서 만드는 쪽이 확실하다.

```bash
ssh -L 18083:127.0.0.1:18083 사용자@서버IP
```

접속한 채로 PC 브라우저에서 `http://127.0.0.1:18083` 을 열고
(아이디 `admin`, 암호는 `.env`의 `EMQX_DASHBOARD_PASSWORD`)
**Access Control → Authentication → Built-in Database → Users**에서 사용자를 추가한다.

대원 전원이 같은 아이디 하나를 써도 된다. 대원별로 나누면 나중에 한 사람만
접속을 끊을 수 있다.

### 6. 확인

```bash
docker exec -it emqx emqx ctl listeners | head -30
```

`wss` 접속이 되는지는 앱에서 바로 확인하는 편이 빠르다.

---

## 앱에 넣기

### 팀장 기기에서 한 번

접속 화면 → **고급 설정**에 세 값을 넣고 입장한다.

- MQTT 브로커: `wss://mqtt.내도메인.com:8084/mqtt`
- 브로커 아이디 / 브로커 암호: 위에서 만든 값

상단 상태가 "연결됨"이 되면 성공이다. "연결 실패"면 아래 문제 해결을 보세요.

### 대원들에게 나눠주기

대원마다 주소와 암호를 손으로 입력하게 하면 현장에서 반드시 사고가 난다.
초대 페이지가 대신 해 준다.

1. 팀장 기기에서 [초대 페이지](../invite.html)를 연다
2. **"자체 브로커 설정도 QR에 담기"** 를 체크한다
3. 그 QR(또는 링크)을 대원에게 보낸다

대원이 그 링크를 한 번 열면 브로커 설정이 기기에 저장되고, 주소창에서는 지워진다.
그 뒤로는 평소처럼 팀 이름과 팀 암호만 넣으면 된다.

**이 QR에는 브로커 암호가 들어 있다.** 팀 밖으로 나가면 남이 브로커에 접속할 수 있다
(팀 데이터는 팀 암호로 암호화되어 있어 읽지는 못하지만, 자원은 쓸 수 있다).
단체 대화방에 아무렇게나 올리지 말고, 새어 나갔다고 판단되면 브로커 아이디를 새로
만들고 QR을 다시 나눠주세요.

팀 암호는 QR에 담기지 않는다. 그건 계속 따로 전달해야 한다.

---

## 보관 기간과 용량

`.env`의 `RETAIN_EXPIRY`가 첨부 보관 기간이다. `30d`, `90d`처럼 적고 영구 보관은 `0s`.
디스크 사용량은 대략 이렇게 잡으면 된다.

- 사진 한 장(자동 축소 후): 200~400KB
- 동영상 1분: 10~30MB

10GB 디스크면 사진 위주 운용에서는 수천 장을 감당한다.

지금 얼마나 쓰고 있는지는 대시보드 **Monitoring → Retained** 에서 볼 수 있다.

## 문제 해결

**"연결 실패"가 뜬다**
브라우저에서 `https://mqtt.내도메인.com` 을 열어 보세요. 인증서 경고가 나오면
아직 발급이 안 된 것이다. `docker compose logs caddy` 로 이유를 확인한다.
대개 DNS가 아직 서버를 가리키지 않거나 80 포트가 막혀 있다.

**연결은 되는데 곧 끊긴다**
아이디·암호가 틀렸을 때 그렇게 보인다. `docker compose logs emqx | tail -50` 에
`authentication failed` 가 있는지 확인한다.

**첨부가 안 보관된다**
`EMQX_RETAINER__MAX_PAYLOAD_SIZE` 보다 큰 조각은 브로커가 버린다.
기본값 1MB면 조각(약 50KB)에 비해 충분하지만, 값을 줄였다면 되돌리세요.

**공개 브로커로 돌아가려면**
고급 설정의 브로커 칸 세 개를 비우고 입장하면 된다.
