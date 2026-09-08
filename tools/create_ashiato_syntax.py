BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def encode_geohash(lat, lon, precision=5):
    """
    緯度・経度をGeohashに変換する。

    lat: 緯度
    lon: 経度
    precision: Geohashの桁数
    """
    lat_interval = [-90.0, 90.0]
    lon_interval = [-180.0, 180.0]

    geohash = []
    bits = []
    even = True

    while len(geohash) < precision:
        if even:
            value = lon
            interval = lon_interval
        else:
            value = lat
            interval = lat_interval

        mid = (interval[0] + interval[1]) / 2

        if value >= mid:
            bits.append(1)
            interval[0] = mid
        else:
            bits.append(0)
            interval[1] = mid

        even = not even

        if len(bits) == 5:
            index = 0
            for bit in bits:
                index = (index << 1) | bit

            geohash.append(BASE32[index])
            bits = []

    return "".join(geohash)


def parse_coordinate(text):
    """
    '@34.7437831,135.541592'
    の形式を (lat, lon) に変換する。
    """
    text = text.strip()

    if text.startswith("@"):
        text = text[1:]

    lat, lon = text.split(",")

    return float(lat), float(lon)


# =========================
# ここを書き換えて使う
# =========================

coordinate = input("@{緯度},{経度} の形式> ")
test_name = input("> ")

lat, lon = parse_coordinate(coordinate)

for precision in range(1, 11):
    geohash = encode_geohash(lat, lon, precision)

    if test_name is None:
        print(f"⟦as;1,c;test,g;{geohash}⟧")
    else:
        print(f"⟦as;1,c;test,g;{geohash},x-test-name;{test_name}-{precision}⟧")

# Geohash精度目安
# 10桁：1m
#  9桁：5m
#  8桁：20～30m
#  7桁：120～150m
#  6桁：600～1200m
#  5桁：4000～5000m
