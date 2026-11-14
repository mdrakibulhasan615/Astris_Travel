/**
 * Ground corridors. Trains, coaches and transfers are drawn (and measured) along the land network
 * instead of as a straight line between two cities, which used to cut across seas and mountain
 * ranges (London → Paris over open Channel, Rome → Dubrovnik across the Adriatic, ...).
 *
 * There is no routing API behind this: it is a hand-built graph of rail/road junction cities with
 * the fixed links that matter (Channel Tunnel, Øresund, Great Belt, Bosphorus, Seikan, ...).
 *   1. `planGroundCorridor` snaps both ends to the network and runs Dijkstra over it.
 *   2. `smoothPath` turns the resulting list of places into a centripetal Catmull-Rom curve, so the
 *      polyline bends through each junction the way a rail line does rather than zig-zagging.
 *
 * Places on different landmasses (Singapore → Jakarta, Dublin → London) have no path, which is how
 * the caller knows not to offer a train or coach there at all.
 *
 * Pure and dependency-free: the server uses it to synthesize options, the browser to draw them.
 */

export type LngLat = [number, number];

interface NetworkNode {
  name: string;
  lat: number;
  lng: number;
}

// prettier-ignore
const NODES: Record<string, NetworkNode> = Object.fromEntries(
  ([
    // Great Britain
    ['London', 51.5074, -0.1278], ['Folkestone', 51.097, 1.139], ['Birmingham', 52.4862, -1.8904],
    ['Manchester', 53.4808, -2.2426], ['Liverpool', 53.4084, -2.9916], ['York', 53.959, -1.0815],
    ['Newcastle', 54.9783, -1.6178], ['Edinburgh', 55.9533, -3.1883], ['Glasgow', 55.8642, -4.2518],
    ['Bristol', 51.4545, -2.5879], ['Cardiff', 51.4816, -3.1791], ['Carlisle', 54.8925, -2.9329],
    // Ireland (own landmass)
    ['Dublin', 53.3498, -6.2603], ['Cork', 51.8985, -8.4756], ['Belfast', 54.5973, -5.9301],
    // France
    ['Calais', 50.925, 1.812], ['Lille', 50.6292, 3.0573], ['Paris', 48.8566, 2.3522],
    ['Lyon', 45.764, 4.8357], ['Marseille', 43.2965, 5.3698], ['Nice', 43.7102, 7.262],
    ['Bordeaux', 44.8378, -0.5792], ['Toulouse', 43.6047, 1.4442], ['Strasbourg', 48.5734, 7.7521],
    ['Nantes', 47.2184, -1.5536], ['Dijon', 47.322, 5.0415], ['Montpellier', 43.6108, 3.8767],
    ['Perpignan', 42.6887, 2.8948], ['Bayonne', 43.4929, -1.4748],
    // Benelux
    ['Brussels', 50.8503, 4.3517], ['Antwerp', 51.2194, 4.4025], ['Rotterdam', 51.9244, 4.4777],
    ['Amsterdam', 52.3676, 4.9041], ['Luxembourg', 49.6116, 6.1319],
    // Germany
    ['Cologne', 50.9375, 6.9603], ['Frankfurt', 50.1109, 8.6821], ['Stuttgart', 48.7758, 9.1829],
    ['Munich', 48.1351, 11.582], ['Nuremberg', 49.4521, 11.0767], ['Berlin', 52.52, 13.405],
    ['Hamburg', 53.5511, 9.9937], ['Hannover', 52.3759, 9.732], ['Leipzig', 51.3397, 12.3731],
    ['Dresden', 51.0504, 13.7373],
    // Alps
    ['Basel', 47.5596, 7.5886], ['Zurich', 47.3769, 8.5417], ['Geneva', 46.2044, 6.1432],
    ['Bern', 46.948, 7.4474], ['Innsbruck', 47.2692, 11.4041], ['Salzburg', 47.8095, 13.055],
    ['Vienna', 48.2082, 16.3738], ['Graz', 47.0707, 15.4395],
    // Italy
    ['Milan', 45.4642, 9.19], ['Turin', 45.0703, 7.6869], ['Genoa', 44.4056, 8.9463],
    ['Verona', 45.4384, 10.9916], ['Venice', 45.4408, 12.3155], ['Bologna', 44.4949, 11.3426],
    ['Florence', 43.7696, 11.2558], ['Rome', 41.9028, 12.4964], ['Naples', 40.8518, 14.2681],
    ['Bari', 41.1171, 16.8719], ['Trieste', 45.6495, 13.7768], ['Villa San Giovanni', 38.22, 15.64],
    ['Catania', 37.5079, 15.083], ['Palermo', 38.1157, 13.3615], ['Salerno', 40.6824, 14.7681],
    ['Paola', 39.3655, 16.0368], ['Portogruaro', 45.7754, 12.8376],
    // Iberia
    ['Barcelona', 41.3874, 2.1686], ['Zaragoza', 41.6488, -0.8891], ['Madrid', 40.4168, -3.7038],
    ['Valencia', 39.4699, -0.3763], ['Cordoba', 37.8882, -4.7794], ['Seville', 37.3891, -5.9845],
    ['Malaga', 36.7213, -4.4214], ['Bilbao', 43.263, -2.935], ['San Sebastian', 43.3183, -1.9812],
    ['Lisbon', 38.7223, -9.1393], ['Porto', 41.1579, -8.6291], ['Tarragona', 41.1189, 1.2445],
    ['Castellon', 39.9864, -0.0513],
    // Nordics
    ['Kolding', 55.4904, 9.4722], ['Odense', 55.4038, 10.4024], ['Copenhagen', 55.6761, 12.5683],
    ['Malmo', 55.605, 13.0038], ['Gothenburg', 57.7089, 11.9746], ['Stockholm', 59.3293, 18.0686],
    ['Oslo', 59.9139, 10.7522], ['Bergen', 60.3913, 5.3221], ['Sundsvall', 62.3908, 17.3069],
    ['Lulea', 65.5848, 22.1547], ['Oulu', 65.0121, 25.4651], ['Tampere', 61.4978, 23.761],
    ['Helsinki', 60.1699, 24.9384], ['Gavle', 60.6749, 17.1413], ['Tornio', 65.8481, 24.1466],
    // Baltics and central Europe
    ['Tallinn', 59.437, 24.7536], ['Riga', 56.9496, 24.1052], ['Kaunas', 54.8985, 23.9036],
    ['Vilnius', 54.6872, 25.2797], ['Warsaw', 52.2297, 21.0122], ['Poznan', 52.4064, 16.9252],
    ['Gdansk', 54.352, 18.6466], ['Wroclaw', 51.1079, 17.0385], ['Krakow', 50.0647, 19.945],
    ['Prague', 50.0755, 14.4378], ['Brno', 49.1951, 16.6068], ['Bratislava', 48.1486, 17.1077],
    ['Budapest', 47.4979, 19.0402], ['Lviv', 49.8397, 24.0297], ['Kyiv', 50.4501, 30.5234],
    // Balkans
    ['Ljubljana', 46.0569, 14.5058], ['Zagreb', 45.815, 15.9819], ['Split', 43.5081, 16.4402],
    ['Dubrovnik', 42.6507, 18.0944], ['Sarajevo', 43.8563, 18.4131], ['Belgrade', 44.7866, 20.4489],
    ['Nis', 43.3209, 21.8958], ['Skopje', 41.9981, 21.4254], ['Thessaloniki', 40.6401, 22.9444],
    ['Athens', 37.9838, 23.7275], ['Sofia', 42.6977, 23.3219], ['Plovdiv', 42.1354, 24.7453],
    ['Edirne', 41.6771, 26.5557], ['Bucharest', 44.4268, 26.1025], ['Cluj-Napoca', 46.7712, 23.6236],
    ['Timisoara', 45.7489, 21.2087], ['Podgorica', 42.4304, 19.2594], ['Tirana', 41.3275, 19.8187],
    ['Larissa', 39.639, 22.4191],
    // Turkey
    ['Istanbul', 41.0082, 28.9784], ['Bursa', 40.1885, 29.061], ['Eskisehir', 39.7767, 30.5206],
    ['Ankara', 39.9334, 32.8597], ['Balikesir', 39.6484, 27.8826], ['Izmir', 38.4237, 27.1428],
    ['Afyon', 38.7507, 30.5567], ['Konya', 37.8746, 32.4932], ['Antalya', 36.8969, 30.7133],
    ['Kayseri', 38.7205, 35.4826], ['Adana', 37.0, 35.3213], ['Gebze', 40.8028, 29.4307],
    // Gulf
    ['Dubai', 25.2048, 55.2708], ['Abu Dhabi', 24.4539, 54.3773], ['Sila', 24.07, 52.72],
    ['Salwa', 24.71, 50.77], ['Doha', 25.2854, 51.531], ['Hofuf', 25.38, 49.59],
    ['Dammam', 26.4207, 50.0888], ['Manama', 26.2285, 50.586], ['Riyadh', 24.7136, 46.6753],
    ['Taif', 21.2703, 40.4158], ['Jeddah', 21.4858, 39.1925], ['Kuwait City', 29.3759, 47.9774],
    ['Sohar', 24.3643, 56.7468], ['Suwaiq', 23.8494, 57.4386], ['Muscat', 23.588, 58.3829],
    // India
    ['Delhi', 28.6139, 77.209], ['Jaipur', 26.9124, 75.7873], ['Agra', 27.1767, 78.0081],
    ['Varanasi', 25.3176, 82.9739], ['Kolkata', 22.5726, 88.3639], ['Ahmedabad', 23.0225, 72.5714],
    ['Mumbai', 19.076, 72.8777], ['Pune', 18.5204, 73.8567], ['Nagpur', 21.1458, 79.0882],
    ['Hyderabad', 17.385, 78.4867], ['Goa', 15.4909, 73.8278], ['Bengaluru', 12.9716, 77.5946],
    ['Chennai', 13.0827, 80.2707], ['Kochi', 9.9312, 76.2673],
    // Mainland Southeast Asia
    ['Singapore', 1.3521, 103.8198], ['Johor Bahru', 1.4927, 103.7414],
    ['Kuala Lumpur', 3.139, 101.6869], ['Ipoh', 4.5975, 101.0901], ['Butterworth', 5.3991, 100.3638],
    ['Hat Yai', 7.0084, 100.4747], ['Surat Thani', 9.1382, 99.3215], ['Phuket', 7.8804, 98.3923],
    ['Chumphon', 10.493, 99.18], ['Hua Hin', 12.5684, 99.9577], ['Ratchaburi', 13.5283, 99.8134],
    ['Bangkok', 13.7563, 100.5018],
    ['Phitsanulok', 16.8211, 100.2659], ['Chiang Mai', 18.7883, 98.9853],
    ['Nakhon Ratchasima', 14.9799, 102.0978], ['Udon Thani', 17.4138, 102.787],
    ['Vientiane', 17.9757, 102.6331], ['Luang Prabang', 19.8856, 102.1347],
    ['Aranyaprathet', 13.66, 102.55], ['Siem Reap', 13.3633, 103.8564],
    ['Phnom Penh', 11.5564, 104.9282], ['Ho Chi Minh City', 10.8231, 106.6297],
    ['Nha Trang', 12.2388, 109.1967], ['Da Nang', 16.0544, 108.2022], ['Dong Hoi', 17.4689, 106.6223],
    ['Vinh', 18.6796, 105.6813],
    ['Hanoi', 21.0278, 105.8342],
    // China
    ['Nanning', 22.817, 108.3665], ['Kunming', 25.0389, 102.7183], ['Guangzhou', 23.1291, 113.2644],
    ['Shenzhen', 22.5431, 114.0579], ['Hong Kong', 22.3193, 114.1694],
    ['Changsha', 28.2282, 112.9388], ['Wuhan', 30.5928, 114.3055], ['Zhengzhou', 34.7466, 113.6254],
    ['Beijing', 39.9042, 116.4074], ['Jinan', 36.6512, 117.1201], ['Nanjing', 32.0603, 118.7969],
    ['Shanghai', 31.2304, 121.4737], ['Hangzhou', 30.2741, 120.1551], ["Xi'an", 34.3416, 108.9398],
    ['Chengdu', 30.5728, 104.0668], ['Chongqing', 29.4316, 106.9123],
    // Korea, Japan, Taiwan (each its own landmass)
    ['Seoul', 37.5665, 126.978], ['Daejeon', 36.3504, 127.3845], ['Daegu', 35.8714, 128.6014],
    ['Busan', 35.1796, 129.0756],
    ['Tokyo', 35.6762, 139.6503], ['Nagoya', 35.1815, 136.9066], ['Kyoto', 35.0116, 135.7681],
    ['Osaka', 34.6937, 135.5023], ['Okayama', 34.6551, 133.9195], ['Hiroshima', 34.3853, 132.4553],
    ['Shimonoseki', 33.9578, 130.9414], ['Fukuoka', 33.5904, 130.4017], ['Oshamambe', 42.5136, 140.3806],
    ['Sendai', 38.2682, 140.8694], ['Aomori', 40.8246, 140.74], ['Hakodate', 41.7687, 140.7288],
    ['Sapporo', 43.0618, 141.3545],
    ['Taipei', 25.033, 121.5654], ['Taichung', 24.1477, 120.6736], ['Kaohsiung', 22.6273, 120.3014],
    // Java + Bali (linked by the short Ketapang ferry that through-coaches use)
    ['Jakarta', -6.2088, 106.8456], ['Cirebon', -6.732, 108.5523], ['Semarang', -6.9667, 110.4167],
    ['Yogyakarta', -7.7956, 110.3695], ['Surabaya', -7.2575, 112.7521],
    ['Banyuwangi', -8.2192, 114.3691], ['Denpasar', -8.6705, 115.2126],
    // Australia (east)
    ['Brisbane', -27.4698, 153.0251], ['Sydney', -33.8688, 151.2093], ['Canberra', -35.2809, 149.13],
    ['Melbourne', -37.8136, 144.9631], ['Adelaide', -34.9285, 138.6007],
    // North America
    ['Boston', 42.3601, -71.0589], ['New York', 40.7128, -74.006], ['Philadelphia', 39.9526, -75.1652],
    ['Washington', 38.9072, -77.0369], ['Montreal', 45.5017, -73.5673], ['Albany', 42.6526, -73.7562],
    ['Toronto', 43.6532, -79.3832], ['Buffalo', 42.8864, -78.8784], ['Cleveland', 41.4993, -81.6944],
    ['Detroit', 42.3314, -83.0458], ['Chicago', 41.8781, -87.6298], ['Pittsburgh', 40.4406, -79.9959],
    ['Charlotte', 35.2271, -80.8431], ['Atlanta', 33.749, -84.388], ['Jacksonville', 30.3322, -81.6557],
    ['Orlando', 28.5383, -81.3792], ['Miami', 25.7617, -80.1918], ['Dallas', 32.7767, -96.797],
    ['Houston', 29.7604, -95.3698], ['Austin', 30.2672, -97.7431], ['New Orleans', 29.9511, -90.0715],
    ['Vancouver', 49.2827, -123.1207], ['Seattle', 47.6062, -122.3321], ['Portland', 45.5152, -122.6784],
    ['Sacramento', 38.5816, -121.4944], ['San Francisco', 37.7749, -122.4194],
    ['Los Angeles', 34.0522, -118.2437], ['San Diego', 32.7157, -117.1611],
    ['Las Vegas', 36.1699, -115.1398], ['Hamilton', 43.2557, -79.8711], ['Erie', 42.1292, -80.0851],
    ['Toledo', 41.6528, -83.5379], ['Bellingham', 48.7519, -122.4787], ['Oceanside', 33.1959, -117.3795],
    // Islands with no fixed link: present so nearby mainland cities are not mistaken for them
    ['Palma', 39.5696, 2.6502], ['Ibiza', 38.9067, 1.4206], ['Cagliari', 39.2238, 9.1217],
    ['Ajaccio', 41.9192, 8.7386], ['Valletta', 35.8989, 14.5146], ['Heraklion', 35.3387, 25.1442],
    ['Larnaca', 34.9003, 33.6232], ['Reykjavik', 64.1466, -21.9426], ['Manila', 14.5995, 120.9842],
    ['Cebu', 10.3157, 123.8854], ['Colombo', 6.9271, 79.8612], ['Medan', 3.5952, 98.6722],
    ['Kota Kinabalu', 5.9804, 116.0735], ['Kuching', 1.5533, 110.3592], ['Haikou', 20.044, 110.1999],
    ['Naha', 26.2124, 127.6809], ['Jeju', 33.4996, 126.5312], ['Hobart', -42.8821, 147.3272],
    ['Auckland', -36.8485, 174.7633], ['Honolulu', 21.3069, -157.8583], ['Havana', 23.1136, -82.3666],
  ] as [string, number, number][]).map(([name, lat, lng]) => [name, { name, lat, lng }])
);

// prettier-ignore
const EDGES: [string, string][] = [
  // Great Britain + Channel Tunnel
  ['London', 'Folkestone'], ['Folkestone', 'Calais'], ['London', 'Birmingham'], ['London', 'Bristol'],
  ['Bristol', 'Cardiff'], ['Bristol', 'Birmingham'], ['Birmingham', 'Manchester'],
  ['Manchester', 'Liverpool'], ['Manchester', 'York'], ['London', 'York'], ['York', 'Newcastle'],
  ['Newcastle', 'Edinburgh'], ['Edinburgh', 'Glasgow'], ['Manchester', 'Carlisle'],
  ['Carlisle', 'Glasgow'], ['Carlisle', 'Edinburgh'],
  ['Dublin', 'Cork'], ['Dublin', 'Belfast'],
  // France
  ['Calais', 'Lille'], ['Lille', 'Paris'], ['Lille', 'Brussels'], ['Paris', 'Dijon'],
  ['Dijon', 'Lyon'], ['Lyon', 'Marseille'], ['Marseille', 'Nice'], ['Marseille', 'Montpellier'],
  ['Montpellier', 'Perpignan'], ['Montpellier', 'Toulouse'], ['Toulouse', 'Bordeaux'],
  ['Paris', 'Bordeaux'], ['Paris', 'Nantes'], ['Nantes', 'Bordeaux'], ['Paris', 'Strasbourg'],
  ['Paris', 'Luxembourg'], ['Lyon', 'Geneva'], ['Lyon', 'Turin'], ['Dijon', 'Basel'],
  ['Strasbourg', 'Basel'], ['Strasbourg', 'Stuttgart'], ['Strasbourg', 'Frankfurt'],
  ['Bordeaux', 'Bayonne'], ['Bayonne', 'San Sebastian'], ['Perpignan', 'Barcelona'], ['Nice', 'Genoa'],
  // Benelux + Germany
  ['Brussels', 'Antwerp'], ['Antwerp', 'Rotterdam'], ['Rotterdam', 'Amsterdam'],
  ['Brussels', 'Cologne'], ['Brussels', 'Luxembourg'], ['Amsterdam', 'Cologne'],
  ['Amsterdam', 'Hannover'], ['Cologne', 'Frankfurt'], ['Cologne', 'Hannover'],
  ['Luxembourg', 'Frankfurt'], ['Frankfurt', 'Stuttgart'], ['Frankfurt', 'Nuremberg'],
  ['Frankfurt', 'Hannover'], ['Frankfurt', 'Leipzig'], ['Frankfurt', 'Basel'],
  ['Stuttgart', 'Munich'], ['Stuttgart', 'Zurich'], ['Nuremberg', 'Munich'],
  ['Nuremberg', 'Leipzig'], ['Nuremberg', 'Prague'], ['Hannover', 'Hamburg'],
  ['Hannover', 'Berlin'], ['Hamburg', 'Berlin'], ['Hamburg', 'Kolding'], ['Leipzig', 'Berlin'],
  ['Leipzig', 'Dresden'], ['Berlin', 'Dresden'], ['Dresden', 'Prague'], ['Berlin', 'Poznan'],
  // Alps
  ['Basel', 'Zurich'], ['Basel', 'Bern'], ['Bern', 'Geneva'], ['Bern', 'Zurich'], ['Bern', 'Milan'],
  ['Zurich', 'Milan'], ['Zurich', 'Innsbruck'], ['Geneva', 'Turin'], ['Munich', 'Innsbruck'],
  ['Munich', 'Salzburg'], ['Innsbruck', 'Verona'], ['Innsbruck', 'Salzburg'],
  ['Salzburg', 'Vienna'], ['Salzburg', 'Ljubljana'], ['Vienna', 'Graz'], ['Graz', 'Ljubljana'],
  ['Graz', 'Zagreb'], ['Vienna', 'Brno'], ['Vienna', 'Bratislava'], ['Vienna', 'Budapest'],
  // Italy
  ['Turin', 'Milan'], ['Turin', 'Genoa'], ['Milan', 'Genoa'], ['Milan', 'Verona'],
  ['Milan', 'Bologna'], ['Verona', 'Venice'], ['Verona', 'Bologna'], ['Venice', 'Portogruaro'],
  ['Portogruaro', 'Trieste'],
  ['Venice', 'Bologna'], ['Trieste', 'Ljubljana'], ['Genoa', 'Florence'], ['Bologna', 'Florence'],
  ['Bologna', 'Bari'], ['Florence', 'Rome'], ['Rome', 'Naples'], ['Naples', 'Bari'],
  ['Naples', 'Salerno'], ['Salerno', 'Paola'], ['Paola', 'Villa San Giovanni'],
  ['Villa San Giovanni', 'Catania'],
  ['Villa San Giovanni', 'Palermo'], ['Catania', 'Palermo'],
  // Iberia
  ['Barcelona', 'Zaragoza'], ['Barcelona', 'Tarragona'], ['Tarragona', 'Zaragoza'],
  ['Tarragona', 'Castellon'], ['Castellon', 'Valencia'], ['Zaragoza', 'Madrid'],
  ['Zaragoza', 'Bilbao'], ['Bilbao', 'San Sebastian'], ['San Sebastian', 'Madrid'],
  ['Madrid', 'Valencia'], ['Madrid', 'Cordoba'], ['Cordoba', 'Seville'], ['Cordoba', 'Malaga'],
  ['Madrid', 'Lisbon'], ['Madrid', 'Porto'], ['Lisbon', 'Porto'], ['Seville', 'Lisbon'],
  // Nordics (Great Belt and Øresund fixed links)
  ['Kolding', 'Odense'], ['Odense', 'Copenhagen'], ['Copenhagen', 'Malmo'],
  ['Malmo', 'Gothenburg'], ['Malmo', 'Stockholm'], ['Gothenburg', 'Stockholm'],
  ['Gothenburg', 'Oslo'], ['Oslo', 'Stockholm'], ['Oslo', 'Bergen'], ['Stockholm', 'Gavle'], ['Gavle', 'Sundsvall'],
  ['Sundsvall', 'Lulea'], ['Lulea', 'Tornio'], ['Tornio', 'Oulu'], ['Oulu', 'Tampere'], ['Tampere', 'Helsinki'],
  // Baltics + central Europe
  ['Tallinn', 'Riga'], ['Riga', 'Kaunas'], ['Kaunas', 'Vilnius'], ['Kaunas', 'Warsaw'],
  ['Warsaw', 'Poznan'], ['Warsaw', 'Gdansk'], ['Gdansk', 'Poznan'], ['Warsaw', 'Krakow'],
  ['Warsaw', 'Lviv'], ['Poznan', 'Wroclaw'], ['Wroclaw', 'Krakow'], ['Wroclaw', 'Prague'],
  ['Wroclaw', 'Dresden'], ['Krakow', 'Brno'], ['Krakow', 'Lviv'], ['Krakow', 'Budapest'],
  ['Lviv', 'Kyiv'], ['Prague', 'Brno'], ['Brno', 'Bratislava'], ['Bratislava', 'Budapest'],
  ['Budapest', 'Zagreb'], ['Budapest', 'Belgrade'], ['Budapest', 'Timisoara'],
  ['Budapest', 'Cluj-Napoca'],
  // Balkans
  ['Ljubljana', 'Zagreb'], ['Zagreb', 'Split'], ['Zagreb', 'Belgrade'], ['Zagreb', 'Sarajevo'],
  ['Split', 'Dubrovnik'], ['Split', 'Sarajevo'], ['Dubrovnik', 'Podgorica'],
  ['Sarajevo', 'Belgrade'], ['Sarajevo', 'Podgorica'], ['Podgorica', 'Tirana'],
  ['Podgorica', 'Belgrade'], ['Tirana', 'Skopje'], ['Tirana', 'Thessaloniki'],
  ['Belgrade', 'Timisoara'], ['Belgrade', 'Nis'], ['Nis', 'Sofia'], ['Nis', 'Skopje'],
  ['Skopje', 'Thessaloniki'], ['Thessaloniki', 'Larissa'], ['Larissa', 'Athens'], ['Thessaloniki', 'Sofia'],
  ['Thessaloniki', 'Edirne'], ['Sofia', 'Plovdiv'], ['Sofia', 'Bucharest'], ['Plovdiv', 'Edirne'],
  ['Timisoara', 'Cluj-Napoca'], ['Timisoara', 'Bucharest'], ['Cluj-Napoca', 'Bucharest'],
  // Turkey (Bosphorus and Osmangazi crossings)
  ['Edirne', 'Istanbul'], ['Istanbul', 'Gebze'], ['Gebze', 'Bursa'], ['Gebze', 'Eskisehir'], ['Bursa', 'Eskisehir'],
  ['Bursa', 'Balikesir'], ['Balikesir', 'Izmir'], ['Eskisehir', 'Ankara'], ['Eskisehir', 'Afyon'],
  ['Afyon', 'Izmir'], ['Afyon', 'Antalya'], ['Afyon', 'Konya'], ['Ankara', 'Konya'],
  ['Ankara', 'Kayseri'], ['Konya', 'Adana'], ['Konya', 'Antalya'], ['Kayseri', 'Adana'],
  // Gulf (coast road, King Fahd Causeway)
  ['Dubai', 'Abu Dhabi'], ['Abu Dhabi', 'Sila'], ['Sila', 'Salwa'], ['Salwa', 'Doha'],
  ['Salwa', 'Hofuf'], ['Hofuf', 'Dammam'], ['Hofuf', 'Riyadh'], ['Dammam', 'Manama'],
  ['Dammam', 'Riyadh'], ['Dammam', 'Kuwait City'], ['Riyadh', 'Taif'], ['Taif', 'Jeddah'],
  ['Dubai', 'Sohar'], ['Sohar', 'Suwaiq'], ['Suwaiq', 'Muscat'],
  // India
  ['Delhi', 'Jaipur'], ['Delhi', 'Agra'], ['Agra', 'Varanasi'], ['Varanasi', 'Kolkata'],
  ['Jaipur', 'Ahmedabad'], ['Ahmedabad', 'Mumbai'], ['Mumbai', 'Pune'], ['Mumbai', 'Goa'],
  ['Pune', 'Hyderabad'], ['Pune', 'Bengaluru'], ['Goa', 'Bengaluru'], ['Agra', 'Nagpur'],
  ['Nagpur', 'Hyderabad'], ['Nagpur', 'Kolkata'], ['Hyderabad', 'Bengaluru'],
  ['Hyderabad', 'Chennai'], ['Bengaluru', 'Chennai'], ['Bengaluru', 'Kochi'], ['Goa', 'Kochi'],
  // Mainland Southeast Asia + China
  ['Singapore', 'Johor Bahru'], ['Johor Bahru', 'Kuala Lumpur'], ['Kuala Lumpur', 'Ipoh'],
  ['Ipoh', 'Butterworth'], ['Butterworth', 'Hat Yai'], ['Hat Yai', 'Surat Thani'],
  ['Surat Thani', 'Phuket'], ['Surat Thani', 'Chumphon'], ['Chumphon', 'Hua Hin'],
  ['Hua Hin', 'Ratchaburi'], ['Ratchaburi', 'Bangkok'],
  ['Bangkok', 'Phitsanulok'], ['Phitsanulok', 'Chiang Mai'], ['Bangkok', 'Nakhon Ratchasima'],
  ['Nakhon Ratchasima', 'Udon Thani'], ['Udon Thani', 'Vientiane'],
  ['Vientiane', 'Luang Prabang'], ['Luang Prabang', 'Kunming'], ['Vientiane', 'Vinh'],
  ['Bangkok', 'Aranyaprathet'], ['Aranyaprathet', 'Siem Reap'], ['Siem Reap', 'Phnom Penh'],
  ['Phnom Penh', 'Ho Chi Minh City'], ['Ho Chi Minh City', 'Nha Trang'],
  ['Nha Trang', 'Da Nang'], ['Da Nang', 'Dong Hoi'], ['Dong Hoi', 'Vinh'], ['Vinh', 'Hanoi'], ['Hanoi', 'Nanning'],
  ['Nanning', 'Guangzhou'], ['Nanning', 'Kunming'], ['Kunming', 'Chengdu'],
  ['Kunming', 'Chongqing'], ['Guangzhou', 'Shenzhen'], ['Shenzhen', 'Hong Kong'],
  ['Guangzhou', 'Changsha'], ['Changsha', 'Wuhan'], ['Changsha', 'Hangzhou'],
  ['Wuhan', 'Zhengzhou'], ['Wuhan', 'Nanjing'], ['Wuhan', 'Chongqing'], ['Zhengzhou', 'Beijing'],
  ['Zhengzhou', "Xi'an"], ['Zhengzhou', 'Jinan'], ["Xi'an", 'Chengdu'], ['Chengdu', 'Chongqing'],
  ['Beijing', 'Jinan'], ['Jinan', 'Nanjing'], ['Nanjing', 'Shanghai'], ['Shanghai', 'Hangzhou'],
  // Korea, Japan (Seikan Tunnel, Kanmon Strait), Taiwan
  ['Seoul', 'Daejeon'], ['Daejeon', 'Daegu'], ['Daegu', 'Busan'],
  ['Tokyo', 'Nagoya'], ['Nagoya', 'Kyoto'], ['Kyoto', 'Osaka'], ['Osaka', 'Okayama'],
  ['Okayama', 'Hiroshima'], ['Hiroshima', 'Shimonoseki'], ['Shimonoseki', 'Fukuoka'], ['Tokyo', 'Sendai'], ['Sendai', 'Aomori'], ['Aomori', 'Hakodate'],
  ['Hakodate', 'Oshamambe'], ['Oshamambe', 'Sapporo'],
  ['Taipei', 'Taichung'], ['Taichung', 'Kaohsiung'],
  // Java + Bali, Australia
  ['Jakarta', 'Cirebon'], ['Cirebon', 'Semarang'], ['Cirebon', 'Yogyakarta'],
  ['Semarang', 'Yogyakarta'], ['Semarang', 'Surabaya'], ['Yogyakarta', 'Surabaya'],
  ['Surabaya', 'Banyuwangi'], ['Banyuwangi', 'Denpasar'],
  ['Brisbane', 'Sydney'], ['Sydney', 'Canberra'], ['Canberra', 'Melbourne'],
  ['Melbourne', 'Adelaide'],
  // North America
  ['Boston', 'New York'], ['New York', 'Philadelphia'], ['Philadelphia', 'Washington'],
  ['Philadelphia', 'Pittsburgh'], ['New York', 'Albany'], ['Albany', 'Montreal'],
  ['Albany', 'Buffalo'], ['Albany', 'Boston'], ['Montreal', 'Toronto'], ['Toronto', 'Hamilton'],
  ['Hamilton', 'Buffalo'],
  ['Toronto', 'Detroit'], ['Buffalo', 'Erie'], ['Erie', 'Cleveland'], ['Cleveland', 'Pittsburgh'],
  ['Cleveland', 'Toledo'], ['Toledo', 'Detroit'], ['Toledo', 'Chicago'], ['Detroit', 'Chicago'],
  ['Pittsburgh', 'Washington'], ['Washington', 'Charlotte'], ['Charlotte', 'Atlanta'],
  ['Atlanta', 'Jacksonville'], ['Atlanta', 'New Orleans'], ['Jacksonville', 'Orlando'],
  ['Orlando', 'Miami'], ['New Orleans', 'Houston'], ['Houston', 'Dallas'], ['Houston', 'Austin'],
  ['Austin', 'Dallas'], ['Vancouver', 'Bellingham'], ['Bellingham', 'Seattle'], ['Seattle', 'Portland'],
  ['Portland', 'Sacramento'], ['Sacramento', 'San Francisco'], ['Sacramento', 'Los Angeles'],
  ['San Francisco', 'Los Angeles'], ['Los Angeles', 'Oceanside'], ['Oceanside', 'San Diego'], ['Los Angeles', 'Las Vegas'],
];

const toRad = (d: number) => (d * Math.PI) / 180;

function km(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const ADJACENCY: Record<string, { to: string; km: number }[]> = {};
for (const name of Object.keys(NODES)) ADJACENCY[name] = [];
for (const [a, b] of EDGES) {
  const na = NODES[a];
  const nb = NODES[b];
  if (!na || !nb) throw new Error(`[groundRouting] edge references unknown place: ${a} – ${b}`);
  const d = km(na.lat, na.lng, nb.lat, nb.lng);
  ADJACENCY[a].push({ to: b, km: d });
  ADJACENCY[b].push({ to: a, km: d });
}

const AT_NODE_KM = 30; // closer than this, the place *is* that junction
const SNAP_RADIUS_KM = 220; // further than this from every junction: outside the network
const MAX_ENTRY_CANDIDATES = 3;
const DIRECT_KM = 60; // too short for the network to add anything

interface Point {
  lat: number;
  lng: number;
}

function entryCandidates(p: Point): { name: string; km: number }[] {
  const near = Object.values(NODES)
    .map((n) => ({ name: n.name, km: km(p.lat, p.lng, n.lat, n.lng) }))
    .filter((c) => c.km <= SNAP_RADIUS_KM)
    .sort((a, b) => a.km - b.km);
  if (near.length > 0 && near[0].km <= AT_NODE_KM) return [near[0]];
  return near.slice(0, MAX_ENTRY_CANDIDATES);
}

export interface GroundStation {
  name: string;
  lng: number;
  lat: number;
}

export type GroundCorridor =
  /** A land route exists; `via` runs origin → junctions → destination. */
  | { status: 'routed'; via: LngLat[]; stations: GroundStation[]; distanceKm: number }
  /** Both ends are on the network but on different landmasses: no train or coach is possible. */
  | { status: 'none' }
  /** One end is outside the network's coverage, so nothing is known either way. */
  | { status: 'unknown' };

/**
 * Land route between two places. `stations` are the intermediate junctions only (the places a
 * through service would call at); `distanceKm` is measured along the route.
 */
export function planGroundCorridor(from: Point, to: Point): GroundCorridor {
  const direct = km(from.lat, from.lng, to.lat, to.lng);
  const start: LngLat = [from.lng, from.lat];
  const end: LngLat = [to.lng, to.lat];
  if (direct <= DIRECT_KM) {
    return { status: 'routed', via: [start, end], stations: [], distanceKm: Math.round(direct) };
  }

  const entries = entryCandidates(from);
  const exits = entryCandidates(to);
  if (entries.length === 0 || exits.length === 0) return { status: 'unknown' };

  // Dijkstra from a virtual source (the origin) to a virtual sink (the destination)
  const dist: Record<string, number> = {};
  const prev: Record<string, string | null> = {};
  const open = new Set<string>();
  for (const e of entries) {
    dist[e.name] = e.km;
    prev[e.name] = null;
    open.add(e.name);
  }
  const exitKm = new Map(exits.map((e) => [e.name, e.km]));
  const done = new Set<string>();
  let best: { name: string; total: number } | null = null;

  while (open.size > 0) {
    let current = '';
    let currentDist = Infinity;
    for (const name of open) {
      if (dist[name] < currentDist) {
        current = name;
        currentDist = dist[name];
      }
    }
    open.delete(current);
    done.add(current);
    if (best && currentDist >= best.total) break;

    const tail = exitKm.get(current);
    if (tail !== undefined && (!best || currentDist + tail < best.total)) {
      best = { name: current, total: currentDist + tail };
    }
    for (const edge of ADJACENCY[current]) {
      if (done.has(edge.to)) continue;
      const next = currentDist + edge.km;
      if (dist[edge.to] === undefined || next < dist[edge.to]) {
        dist[edge.to] = next;
        prev[edge.to] = current;
        open.add(edge.to);
      }
    }
  }

  if (!best) return { status: 'none' };
  // A "land route" several times longer than the crow flies means water in between that people
  // cross by ferry or plane (Helsinki → Tallinn round the Baltic), not a real train or coach.
  if (best.total > direct * 2.5 + 300) return { status: 'none' };

  const names: string[] = [];
  for (let n: string | null = best.name; n; n = prev[n] ?? null) names.unshift(n);

  // Junctions that coincide with an endpoint are the endpoint, not an intermediate call
  const stations = names
    .map((name) => NODES[name])
    .filter(
      (n) =>
        km(from.lat, from.lng, n.lat, n.lng) > AT_NODE_KM &&
        km(to.lat, to.lng, n.lat, n.lng) > AT_NODE_KM
    )
    .map((n) => ({ name: n.name, lng: n.lng, lat: n.lat }));

  const via: LngLat[] = [start, ...stations.map((s): LngLat => [s.lng, s.lat]), end];
  let routed = 0;
  for (let i = 1; i < via.length; i++) routed += km(via[i - 1][1], via[i - 1][0], via[i][1], via[i][0]);
  // Real track and road wander ~12% more than the chord between junctions
  return { status: 'routed', via, stations, distanceKm: Math.round(routed * 1.12) };
}

function dedupe(points: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * Centripetal Catmull-Rom curve through every point (it passes exactly through each one, and the
 * centripetal form does not loop or overshoot at sharp turns the way the uniform form does).
 */
export function smoothPath(input: LngLat[], samplesPerSpan = 10): LngLat[] {
  const pts = dedupe(input);
  if (pts.length < 3) return pts;

  const out: LngLat[] = [pts[0]];
  const knot = (a: LngLat, b: LngLat) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const lerp = (a: LngLat, b: LngLat, ta: number, tb: number, t: number): LngLat => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    // Phantom end points mirror the neighbour so the curve leaves and arrives along the chord
    const p0: LngLat = i > 0 ? pts[i - 1] : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    const p3: LngLat = i + 2 < pts.length ? pts[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 1; s <= samplesPerSpan; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSpan;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      out.push(lerp(b1, b2, t1, t2, t));
    }
  }
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}

/** A shallow arc between two points, for legs whose real alignment is not known. */
export function bowedLine(from: LngLat, to: LngLat, bend = 0.08, samples = 16): LngLat[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const control: LngLat = [(from[0] + to[0]) / 2 - dy * bend, (from[1] + to[1]) / 2 + dx * bend];
  const out: LngLat[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    out.push([
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ]);
  }
  return out;
}

interface GroundLeg {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  waypoints?: [number, number][];
}

/**
 * Polyline for one ground segment plus the station dots to draw on it.
 *  - explicit `waypoints` (curated stations, or a corridor stored by the synthesizer) are smoothed;
 *  - otherwise the corridor is planned here, so a segment with no geometry still follows the land;
 *  - short airport transfers and legs outside the network fall back to a shallow arc.
 */
export function groundGeometry(
  leg: GroundLeg,
  options: { isConnector?: boolean } = {}
): { coordinates: LngLat[]; stations: LngLat[] } {
  const start: LngLat = [leg.fromLng, leg.fromLat];
  const end: LngLat = [leg.toLng, leg.toLat];

  if (leg.waypoints && leg.waypoints.length >= 2) {
    const through = dedupe(leg.waypoints);
    if (through.length >= 3) {
      return { coordinates: smoothPath(through), stations: through.slice(1, -1) };
    }
  }

  if (!options.isConnector) {
    const corridor = planGroundCorridor(
      { lat: leg.fromLat, lng: leg.fromLng },
      { lat: leg.toLat, lng: leg.toLng }
    );
    if (corridor.status === 'routed' && corridor.via.length >= 3) {
      return { coordinates: smoothPath(corridor.via), stations: corridor.via.slice(1, -1) };
    }
  }

  return { coordinates: bowedLine(start, end, options.isConnector ? 0.06 : 0.1), stations: [] };
}
