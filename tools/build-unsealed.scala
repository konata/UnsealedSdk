//> using scala 3.3.7
//> using jvm 21
//> using file ClassFile.scala Transform.scala StubNames.scala

import java.nio.file.{Files, Path, StandardCopyOption}
import java.security.MessageDigest
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilderFactory
import scala.jdk.CollectionConverters.*
import scala.sys.process.*
import scala.util.Using

object BuildUnsealed:
  private val repository = "https://dl.google.com/android/repository/"
  private val robolectric = "https://repo1.maven.org/maven2/org/robolectric/android-all/"
  private val releases = Map(28 -> "9", 29 -> "10", 30 -> "11", 31 -> "12", 32 -> "12.1", 33 -> "13", 34 -> "14", 35 -> "15", 36 -> "16", 37 -> "17")
  private val blacklist = Vector("com/android/server/", "android/car/", "com/android/car/")
  private val cache = Path.of(".unsealed-sdk/cache").toAbsolutePath

  final case class Api(major: Int, minor: Int):
    override def toString: String = if major < 37 && minor == 0 then major.toString else s"$major.$minor"
    def release: String = releases.getOrElse(major, throw IllegalArgumentException(s"API $this: no Android release known for major $major; extend the releases table"))
  object Api:
    def parse(value: String): Api =
      val pattern = "([1-9]\\d*)(?:\\.(0|[1-9]\\d*))?".r
      value match
        case pattern(majorDigits, minorDigits) =>
          val major = majorDigits.toInt
          val minor = Option(minorDigits).fold(0)(_.toInt)
          require(!(major < 37 && minor == 0 && minorDigits != null), s"API $value: API $major and earlier do not take an explicit zero minor; pass $major")
          require(!(major >= 37 && minorDigits == null), s"API $value: API $major and later must name the minor explicitly, e.g. $major.0")
          Api(major, minor)
        case _ => throw IllegalArgumentException(s"API $value is not supported: expected digits with an optional minor, e.g. 36, 36.1, 37.0, 37.1")

  final case class Options(api: Api, androidAll: Option[String], output: Path)
  private def options(arguments: List[String]): Options =
    def parse(rest: List[String], api: Option[Api], version: Option[String], output: Option[Path]): Options = rest match
      case "--android-all" :: value :: tail => parse(tail, api, Some(value), output)
      case "--out" :: value :: tail => parse(tail, api, version, Some(Path.of(value)))
      case value :: tail if !value.startsWith("--") && api.isEmpty => parse(tail, Some(Api.parse(value)), version, output)
      case Nil if api.nonEmpty => Options(api.get, version, output.getOrElse(Path.of(s"sdks/android-${api.get}.jar")).toAbsolutePath)
      case _ => throw IllegalArgumentException("usage: scala-cli run tools/build-unsealed.scala -- <api> [--android-all <version>] [--out <jar>]")
    parse(arguments, None, None, None)

  private def command(arguments: String*): Unit =
    val status = Process(arguments).!
    require(status == 0, s"${arguments.head} exited $status")
  private def fetch(url: String): String = Process(Seq("curl", "-fsSL", "-A", "UnsealedSdk/1.0", url)).!!
  private def sha1(path: Path): String = Using.resource(Files.newInputStream(path)): input =>
    val digest = MessageDigest.getInstance("SHA-1")
    val buffer = new Array[Byte](65536)
    Iterator.continually(input.read(buffer)).takeWhile(_ >= 0).foreach(length => digest.update(buffer, 0, length))
    java.util.HexFormat.of().formatHex(digest.digest())
  private def cached(url: String, expected: String): Path =
    Files.createDirectories(cache)
    val path = cache.resolve(url.split('/').last)
    if Files.exists(path) && sha1(path) == expected then return path
    command("curl", "-fsSL", "-A", "UnsealedSdk/1.0", url, "-o", path.toString)
    val actual = sha1(path)
    require(actual == expected, s"$path sha1 $actual, expected $expected")
    path

  private def platform(api: Api): (String, String) =
    val factory = DocumentBuilderFactory.newInstance()
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
    val document = factory.newDocumentBuilder().parse(new java.io.ByteArrayInputStream(fetch(repository + "repository2-3.xml").getBytes(java.nio.charset.StandardCharsets.UTF_8)))
    val packages = document.getElementsByTagName("remotePackage")
    val selected = (0 until packages.getLength).map(packages.item).collectFirst:
      case element: org.w3c.dom.Element if element.getAttribute("path") == s"platforms;android-$api" => element
    val complete = selected.getOrElse(throw IllegalArgumentException(s"No SDK platform package for API $api"))
      .getElementsByTagName("complete").item(0).asInstanceOf[org.w3c.dom.Element]
    val url = complete.getElementsByTagName("url").item(0).getTextContent
    val checksum = complete.getElementsByTagName("checksum").item(0).getTextContent
    (java.net.URI.create(repository).resolve(url).toString, checksum)

  private def latest(release: String): String =
    val versions = "<version>([^<]+)</version>".r.findAllMatchIn(fetch(robolectric + "maven-metadata.xml"))
      .map(_.group(1)).filter(_.startsWith(s"$release-robolectric-")).toVector
    // Numeric segments sort naturally, including the numeric suffix of a rebuilt release.
    def natural(left: String, right: String): Boolean =
      val parts = "[0-9]+|[^0-9]+".r
      val comparison = parts.findAllIn(left).zip(parts.findAllIn(right)).map: (a, b) =>
        if a.head.isDigit && b.head.isDigit then BigInt(a).compare(BigInt(b)) else a.compareTo(b)
      comparison.find(_ != 0).fold(left.length < right.length)(_ < 0)
    versions.sortWith(natural).lastOption.getOrElse(throw IllegalArgumentException(s"No android-all build for Android $release"))

  private def extract(archive: Path, destination: Path, name: String): Unit = Using.resource(new ZipFile(archive.toFile)): zip =>
    val entry = zip.entries.asScala.find(entry => entry.getName.split('/').length == 2 && entry.getName.endsWith(s"/$name"))
      .getOrElse(throw IllegalArgumentException(s"$archive has no $name"))
    Using.resource(zip.getInputStream(entry))(input => Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING))

  private def classes(directory: Path): Vector[Path] = Using.resource(Files.walk(directory)):
    _.iterator.asScala.filter(_.toString.endsWith(".class")).map(directory.relativize).toVector.sortBy(_.toString)
  private def write(path: Path, bytes: Array[Byte]): Unit =
    Files.createDirectories(path.getParent)
    Files.write(path, bytes)

  def main(arguments: Array[String]): Unit =
    val Options(api, androidAll, output) = options(arguments.toList)
    val release = api.release
    val work = Path.of(s".unsealed-sdk/android-$api").toAbsolutePath
    if Files.exists(work) then Using.resource(Files.walk(work)):
      _.iterator.asScala.toVector.reverse.foreach(Files.delete)
    Files.createDirectories(work)
    val merge = work.resolve("merge")
    val overlay = work.resolve("overlay")
    val supplement = work.resolve("supplement")
    val (url, checksum) = platform(api)
    println(s"platform platforms;android-$api -> $url")
    val archive = cached(url, checksum)
    val official = work.resolve("official-android.jar")
    extract(archive, official, "android.jar")
    val sourceJar = work.resolve("android-stubs-src.jar")
    val sources = work.resolve("sources")
    extract(archive, sourceJar, "android-stubs-src.jar")
    command("unzip", "-oq", sourceJar.toString, "-d", sources.toString)
    val names = StubNames.read(sources)

    val version = androidAll.getOrElse(latest(release))
    val androidAllUrl = s"$robolectric$version/android-all-$version.jar"
    println(s"android-all $version -> $androidAllUrl")
    val androidJar = cached(androidAllUrl, fetch(androidAllUrl + ".sha1").trim.split("\\s+").head)
    val properties = Using.resource(new ZipFile(androidJar.toFile)): zip =>
      Using.resource(zip.getInputStream(zip.getEntry("build.prop")))(input => new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
    val sdk = "(?m)^ro\\.build\\.version\\.sdk=(\\d+)$".r.findFirstMatchIn(properties).map(_.group(1))
    require(sdk.contains(api.major.toString), s"${androidJar.getFileName} is built for SDK $sdk, not API $api")

    // Resource PNGs are omitted: linking needs resources.arsc, and devices supply the images.
    command("unzip", "-oq", official.toString, "-x", "*.class", "res/*.png", "-d", merge.toString)
    command("unzip", "-oq", official.toString, "java/*", "javax/*", "-d", merge.toString)
    command((Seq("unzip", "-oq", androidJar.toString, "*.class", "-x") ++ blacklist.map(_ + "*") ++ Seq("-d", overlay.toString))*)
    val overlayClasses = classes(overlay)
    println(s"stub ${overlayClasses.size} android-all classes (blacklist: ${blacklist.mkString(" ")})")
    overlayClasses.foreach: entry =>
      try write(merge.resolve(entry), Transform.stub(Files.readAllBytes(overlay.resolve(entry)), names))
      catch case cause: Exception => throw RuntimeException(s"cannot stub $entry", cause)

    if api.minor > 0 then
      command("unzip", "-oq", official.toString, "*.class", "-d", supplement.toString)
      var newClasses, patchedClasses, newMembers, newInnerClasses = 0
      classes(supplement).filterNot(entry => blacklist.exists(entry.toString.startsWith)).foreach: entry =>
        val target = merge.resolve(entry)
        val source = Files.readAllBytes(supplement.resolve(entry))
        if !Files.exists(target) then
          write(target, source)
          newClasses += 1
        else
          try
            val result = Transform.supplement(Files.readAllBytes(target), source, names)
            if result.members + result.innerClasses > 0 then
              write(target, result.bytes)
              patchedClasses += 1
              newMembers += result.members
              newInnerClasses += result.innerClasses
          catch case cause: Exception => throw RuntimeException(s"cannot supplement $entry", cause)
      println(s"supplement $newClasses classes new in $api from the official jar (stub level only)")
      println(s"supplement $newMembers members and $newInnerClasses InnerClasses entries in $patchedClasses existing classes from the official jar")

    Files.deleteIfExists(output)
    val status = Process(Seq("zip", "-qrX", output.toString, "."), merge.toFile).!
    require(status == 0, s"zip exited $status")
    println(s"wrote $output (${Files.size(output)} bytes)")
