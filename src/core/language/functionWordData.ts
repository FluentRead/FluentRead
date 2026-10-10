/**
 * @file src/core/language/functionWordData.ts
 * 文件职责：保存统计语言识别的原始功能词字符串，供 lexicon.ts 按原有顺序建立 Set。
 * 主要内容：维护 Latin、Cyrillic、Arabic、Devanagari 四组的功能词列表，包含挪威新挪威语的目录外反证和马拉地语的代词、限定词、连词与时间副词；本文件仅含导出的 const 字符串，不收录网页或产品名。
 * 模块边界：不执行识别、切词或浏览器操作；仅 userscript 非 Greasy Fork 构建通过现有静态数据管线无损压缩，扩展直接消费明文数据。
 */

export const latinEnWords = "the a an and or but of to in on at for with from by is are was were be been being this that these those it its you your we our they their he she his her not will would can could have has had do does did what which who how there here about into than then if as all more no so just only also very";
export const latinFrWords = "le la les un une des du de et ou mais est sont être avoir pour par avec dans sur sous ce cette ces qui que quoi nous vous ils elles il elle je ne pas plus notre nos votre vos leur leurs au aux très aussi comme où sans entre chez cela été fait peut son sa ses mon ma mes tout tous";
export const latinDeWords = "der die das den dem des ein eine einen einem einer und oder aber ist sind war wird werden wurde wurden nicht mit auf für von zu zum zur im in an bei aus nach über unter auch sich es wir ihr sie ich du unser unsere unserer ihre dieser diese dieses noch schon sehr wie wenn dass kann können hier kein keine";
export const latinEsWords = "el la los las un una unos unas y o pero de del al en con por para sin sobre es son está están ser fue que se su sus nuestro nuestra nuestros nuestras este esta estos estas muy más también como cuando donde hay lo le les mi tu usted ustedes nosotros ya no sí puede";
export const latinPtWords = "o a os as um uma uns umas e ou mas de do da dos das no na nos nas em com por para sem sobre é são está estão ser foi que se seu sua seus suas nosso nossa nossos nossas este esta isso isto muito mais também como quando onde há não você vocês ao aos pelo pela pode";
export const latinItWords = "il lo la i gli le un uno una e o ma di del della dei delle a al alla in nel nella con per su sul sulla da dal è sono essere che non si suo sua nostro nostra nostri questo questa molto più anche come quando dove ci vi noi voi può tutto";
export const latinNlWords = "de het een en of maar van in op aan met voor door bij uit naar is zijn was wordt worden niet geen ook dit dat deze die wij we jullie ze zij hij ik je u uw ons onze er hier nog al wel om te als kan";
export const latinPlWords = "i w na z do się nie jest są to że jak ale lub oraz dla od po przez przy o co czy ten ta te tego nasz nasza naszej naszym wasz jego jej ich my wy oni być był była może tylko już bardzo także też aby";
export const latinCsWords = "a i v ve na s se si k z do je jsou byl být to že jak ale nebo pro od po při o co ten ta tento tato naše našich náš váš jeho její jejich my vy oni není také jen už velmi jako když kde abychom";
export const latinSkWords = "a i aj v vo na s so sa si k z do je sú bol byť to že ako ale alebo pre od po pri o čo ten táto naša našej náš váš jeho jej ich my vy oni nie tiež len už veľmi keď kde aby sme ste";
export const latinRoWords = "și în de la cu pe din pentru este sunt a al ale un o unei unui care că nu se mai ce acest această nostru noastră vă ne sau dar prin după foarte fost fi";
export const latinHuWords = "a az és egy is nem van vagy hogy de meg ez azt ezt mint már csak még sem el ki be fel le ön önök minden nagyon lesz volt lehet kell";
export const latinTrWords = "ve bir bu için ile da de ne çok daha gibi olarak olan var yok değil mi mı ama veya her şu o ben sen biz siz onlar kadar sonra önce en";
export const latinViWords = "và của là có không được cho với các những một này đó trong trên khi đã sẽ đang người bạn chúng tôi ta để từ về như thì mà rất cũng";
export const latinIdWords = "dan yang di ke dari untuk dengan ini itu adalah tidak akan pada dalam juga kami kita anda mereka saya atau tetapi bisa sudah belum ada oleh sebagai karena lebih sangat bahwa telah";
export const latinMsWords = "dan yang di ke dari untuk dengan ini itu ialah adalah tidak akan pada dalam juga kami kita anda mereka saya atau tetapi boleh sudah belum ada oleh sebagai kerana lebih sangat bahawa telah sila";
export const latinFilWords = "ang ng mga sa at ay na para ko mo ka siya kami kayo ito iyon hindi may nang kung pero ni si aming inyong ating iyong";
export const latinSwWords = "na ya wa za la kwa ni katika hii huu hiyo kama lakini au sisi wewe yeye wao kuwa pia sana hapa yetu zetu wetu yako ili";
export const latinSvWords = "och i att det som en ett på är för med av till den har inte om vi du han hon de jag var kan men eller från vår vårt våra er ert era också mycket när kvar efter före även sedan genom utan mellan själv någon något alla varandra här där då nu så bara varje vem vad vars";
export const latinDaWords = "og i at det som en et på er for med af til den har ikke om vi du han hun de jeg var kan men eller fra vores jeres også meget hvad hvor blevet efter før når selv igen stadig nu så kun alle hver nogle noget nogen mellem uden hvem der her siden fordi hvis";
export const latinNbWords = "og i å at det som en et på er for med av til den har ikke om vi du han hun de jeg var kan men eller fra vår vårt våre deres også veldig hva hvor blitt etter før når selv igjen nå så bare alle hver noen noe mellom uten hvem der her siden fordi hvis fortsatt enn mye";
export const latinNnWords = "og i å at det som ein eit på er for med av til den har ikkje om vi du han ho dei eg var kan men eller frå vår vårt våre dykk dykkar også mykje kva kvar kven når medan dersom då no så berre etter før utan mellom sjølv framleis att vert vore vera desse denne dette nokon noko alle kvarandre";
export const latinFiWords = "ja on ei se että tämä mutta tai kun jos niin myös vain olla ovat oli me te he minä sinä hän meidän teidän kanssa mukaan jälkeen ennen hyvin joka mikä";
export const latinEtWords = "ja on ei see et aga või kui siis ka ainult olla oli me te nad mina sina tema meie teie oma kõik väga mis kes selle nagu";
export const latinLvWords = "un ir ar uz no par kas ka bet vai arī ļoti mēs jūs viņi es tu viņš viņa mūsu jūsu šis šī tas tā nav būt bija kā kur lai tiek";
export const latinLtWords = "ir į su iš ant apie kad bet ar taip pat labai mes jūs jie aš tu jis ji mūsų jūsų šis ši tas ta nėra būti buvo kaip kur yra po";
export const latinSlWords = "in je v na z s za da se so ne pa ki kot ali tudi samo zelo mi vi oni jaz ti on ona naš naša našo vaš to ta biti bil kje smo";
export const latinHrWords = "i u na je se da za s sa od do su ne a ali ili kao što koji ovo to mi vi oni ja ti on ona naš naša našu vaš biti bio vrlo gdje kako također smo";
export const latinBsWords = "i u na je se da za s sa od do su ne a ali ili kao što koji ovo to mi vi oni ja ti on ona naš naša našu vaš biti bio veoma gdje kako također smo";
export const latinSrLatnWords = "i u na je se da za sa od do su ne a ali ili kao što koji ovo to mi vi oni ja ti on ona naš naša našu vaš biti bio veoma gde kako takođe smo";
export const latinCaWords = "el la els les un una uns unes i o però de del dels a al als en amb per sense sobre és són era ser que es se seu seva seus seves nostre nostra aquest aquesta aquests aquestes molt més també com quan on hi ha no ja vaig va van em et ens us li";
export const latinGlWords = "o a os as un unha uns unhas e ou pero de do da dos das no na nos nas en con por para sen sobre é son está están ser foi que se seu súa seus súas noso nosa este esta isto moi máis tamén como cando onde hai non xa ca";
export const latinAfWords = "die en of maar van in op aan met vir deur by uit na is was word het nie ook dit dat hierdie ek jy hy sy ons julle hulle my jou sal kan baie as wat waar hoe";
export const cyrillicRuWords = "и в во не на я что он с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда наш наша наше наши это этот эта мы они для есть будет очень также или чтобы";
export const cyrillicUkWords = "і й в у не на я що він з із як а то все вона так його але ти до ж ви за б по тільки її мені було ось від мене ще немає про йому тепер коли наш наша наше наші це цей ця ми вони для є буде дуже також або щоб";
export const cyrillicBgWords = "и в във не на аз че той с със като а то всички тя така го но да ти към вие за би по само ми беше ето от още няма му сега когато наш нашия нашата нашите това този тази ние те е са ще много също или";
export const cyrillicSrWords = "и у на је се да за са од до су не а али или као што који ово то ми ви они ја ти он она наш наша ваш бити био веома где како такође смо";
export const cyrillicBeWords = "і ў у не на я што ён з як а то усё яна так яго але ты да вы за па толькі мне было ад яшчэ няма пра калі наш наша гэта гэты мы яны для ёсць будзе вельмі таксама або";
export const cyrillicKkWords = "және мен бұл да де бір үшін емес бар жоқ біз сіз олар сен ол біздің сіздің осы сол өте қазір қалай қайда";
export const cyrillicMkWords = "и во на не се да за со од до се а но или како што кој ова тоа ние вие тие јас ти тој таа наш наша ваш биде беше многу каде исто";
export const arabicArWords = "في من على إلى عن مع هذا هذه ذلك التي الذي الذين هو هي نحن أنت أنتم هم كان كانت يكون لا لم لن ما ماذا كل بعد قبل أو ثم حتى إذا قد أن إن لقد تم";
export const arabicFaWords = "و در به از که این آن با برای را است هستند بود شد می ما شما آنها من تو او یک هم نیز تا اگر یا اما خود بسیار خیلی هر چه";
export const arabicUrWords = "اور میں کے کی کا کو سے پر یہ وہ ہے ہیں تھا تھی نہیں ہم آپ ایک بھی کہ جو اگر یا لیکن بہت ہماری ہمارا گئی گیا";
export const devanagariHiWords = "और का की के में है हैं को से पर यह वह एक नहीं हम आप मैं तुम था थी थे भी तो कि जो लिए साथ हमारी हमारा आपका आपके बहुत गए गई";
export const devanagariMrWords = "आणि च्या ची चा चे मध्ये आहे आहेत ला ने हे ते एक नाही आम्ही तुम्ही मी होता होती पण की जो साठी सह आमच्या आपले खूप वर तुमचे आता नंतर पुन्हा किंवा जर तर म्हणून तसेच जेव्हा तेव्हा जरी तरी या त्या याचा त्याचा याची त्याची यांचे त्यांचे आपल्या आम्हाला तुम्हाला तिला त्याला मला त्यांनी यांनी प्रत्येक काही सर्व एखादा एखादी एखादे";
export const devanagariNeWords = "र को का की मा छ छन् लाई बाट यो त्यो एक छैन हामी तपाईं म थियो पनि कि जो लागि साथ हाम्रो तपाईंको धेरै हो गरिए";
