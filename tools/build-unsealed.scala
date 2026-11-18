//> using scala 3.3.7
//> using jvm 21
//> using dep org.ow2.asm:asm:9.11.1 org.ow2.asm:asm-tree:9.11.1

import org.objectweb.asm.*
import org.objectweb.asm.Opcodes.*
import org.objectweb.asm.tree.*
import com.sun.source.tree.*
import com.sun.source.util.JavacTask
import javax.tools.{Diagnostic, DiagnosticCollector, JavaFileObject, SimpleJavaFileObject, ToolProvider}
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.{Files, Path}
import java.nio.file.StandardCopyOption.{ATOMIC_MOVE, REPLACE_EXISTING}
import java.security.MessageDigest
import java.util.zip.{ZipEntry, ZipFile, ZipOutputStream}
import scala.collection.mutable
import scala.jdk.CollectionConverters.*
import scala.sys.process.*
import scala.util.Using

object BuildUnsealed:
  private val repository = "https://dl.google.com/android/repository/"
  private val robolectric = "https://repo1.maven.org/maven2/org/robolectric/android-all/"
  private val snapshots = Map(
    28 -> "9-robolectric-4913185-2", 29 -> "10-robolectric-5803371",
    30 -> "11-robolectric-6757853", 31 -> "12-robolectric-7732740",
    32 -> "12.1-robolectric-8229987", 33 -> "13-robolectric-9030017",
    34 -> "14-robolectric-10818077", 35 -> "15-robolectric-14663667-2",
    36 -> "16-robolectric-13921718-2", 37 -> "17-robolectric-16653203")
  // Package revisions and SHA-1 digests from Google's repository2-3.xml.
  private val platforms = Map(
    "28" -> ("platform-28_r06.zip", "9a4e52b1d55bd2e24216b150aafae2503d3efba6"),
    "29" -> ("platform-29_r05.zip", "9d8a7e0ffa5168dbca6c60355b9129c6c7572aff"),
    "30" -> ("platform-30_r03.zip", "e7c6280901dcfa511af098d67dd88c4dfcbc6ea2"),
    "31" -> ("platform-31_r01.zip", "ca5bcaa565cb37e9d287051d6dd0e49a5426ec29"),
    "32" -> ("platform-32_r01.zip", "afae86ed55d29733d50996ffed832f2d1bd75b9a"),
    "33" -> ("platform-33-ext3_r03.zip", "394bc86d8d3452aa4d419b67743025a6fb2cd9d0"),
    "34" -> ("platform-34-ext7_r03.zip", "1f2e9478d6a7601425ceaa553311dc43191f103d"),
    "35" -> ("platform-35_r02.zip", "0bb560a90a7a2cbd0dd8348224d518b638fe7949"),
    "36" -> ("platform-36_r02.zip", "2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576"),
    "36.1" -> ("platform-36.1_r01.zip", "f87dc23b7ddba6934908da6cfb58fd5b258077ce"),
    "37.0" -> ("platform-37.0_r02.zip", "ed8ebf7f8822a4de5686d427f237d2fa30ff7410"),
    "37.1" -> ("platform-37.1_r01.zip", "62aeba1ec09c2b1fdf888e79549daf678fa0d75f"),
    "37.2" -> ("platform-37.2_r02.zip", "d52b3062af96f7c4dfdca5a479cd1db33ae83762"))
  private val blacklist = Vector("com/android/server/", "android/car/", "com/android/car/")
  private val cache = Path.of(".unsealed-sdk/cache").toAbsolutePath

  final case class Api(major: Int, minor: Int):
    override def toString: String = if major < 37 && minor == 0 then major.toString else s"$major.$minor"
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

  private def curl(arguments: String*) = Process(Seq("curl", "-fsSL", "-A", "UnsealedSdk/1.0") ++ arguments)
  private def sha1(path: Path): String = Using.resource(Files.newInputStream(path)): input =>
    val digest = MessageDigest.getInstance("SHA-1")
    val buffer = new Array[Byte](65536)
    Iterator.continually(input.read(buffer)).takeWhile(_ >= 0).foreach(length => digest.update(buffer, 0, length))
    java.util.HexFormat.of().formatHex(digest.digest())
  private def cached(url: String, expected: String): Path =
    Files.createDirectories(cache)
    val path = cache.resolve(url.split('/').last)
    if Files.exists(path) && sha1(path) == expected then return path
    val download = Files.createTempFile(cache, "download-", ".part")
    try
      require(curl(url, "-o", download.toString).! == 0, s"download failed: $url")
      val actual = sha1(download)
      require(actual == expected, s"$url sha1 $actual, expected $expected")
      Files.move(download, path, ATOMIC_MOVE, REPLACE_EXISTING)
    finally Files.deleteIfExists(download)

  private def entries(zip: ZipFile) = zip.entries.asScala.filterNot(_.isDirectory)
  private def bytes(zip: ZipFile, name: String): Array[Byte] =
    Using.resource(zip.getInputStream(zip.getEntry(name)))(_.readAllBytes())
  private def nested(platform: ZipFile, work: Path, name: String): Path =
    val entry = entries(platform).find: entry =>
      entry.getName.split("/", 2) match
        case Array(_, `name`) => true
        case _ => false
    val path = work.resolve(name)
    val member = entry.getOrElse(throw IllegalArgumentException(s"${platform.getName} has no $name"))
    Using.resource(platform.getInputStream(member))(input => Files.copy(input, path))
    path

  private def assemble(api: Api, official: ZipFile, android: ZipFile, sources: StubNames, jar: ZipOutputStream): Unit =
    val surface = entries(official).map(_.getName).toSet
    val overlay = entries(android).map(_.getName).filter(_.endsWith(".class")).toSet
    def runtime(name: String) = name.startsWith("java/") || name.startsWith("javax/")
    val assets = surface.filterNot(_.endsWith(".class")).filterNot(n => n.startsWith("res/") && n.endsWith(".png"))
    val classes = (overlay ++ surface.filter(n => n.endsWith(".class") && (runtime(n) || api.minor > 0)))
      .filterNot(name => blacklist.exists(name.startsWith))
    (assets ++ classes).toVector.sorted.foreach: name =>
      val entry = new ZipEntry(name)
      entry.setTimeLocal(java.time.LocalDateTime.of(2000, 1, 1, 0, 0))
      jar.putNextEntry(entry)
      if assets(name) then Using.resource(official.getInputStream(official.getEntry(name)))(_.transferTo(jar))
      else
        try
          val officialWins = surface(name) && (runtime(name) || !overlay(name))
          if officialWins then jar.write(Transform.official(bytes(official, name), sources))
          else
            val supplement = Option.when(api.minor > 0 && surface(name))(bytes(official, name))
            jar.write(Transform.stub(bytes(android, name), supplement, sources))
        catch case cause: Exception => throw RuntimeException(s"cannot assemble $name", cause)
      jar.closeEntry()
    println(s"${classes.size} classes, ${assets.size} assets; ${sources.coverage}")

  def main(arguments: Array[String]): Unit =
    val Options(api, androidAll, output) = options(arguments.toList)
    val (archive, checksum) = platforms.getOrElse(api.toString, throw IllegalArgumentException(s"No pinned SDK platform for API $api"))
    val version = androidAll.getOrElse(snapshots(api.major))
    val url = s"$robolectric$version/android-all-$version.jar"
    println(s"platform $archive, android-all $version")
    val platform = cached(repository + archive, checksum)
    val framework = cached(url, curl(url + ".sha1").!!.trim.split("\\s+").head)
    Files.createDirectories(output.getParent)
    val work = Files.createTempDirectory(output.getParent, ".unsealed-")
    val pending = work.resolve("unsealed.jar")
    try
      Using.Manager { use =>
        val sdk = use(new ZipFile(platform.toFile))
        val official = use(new ZipFile(nested(sdk, work, "android.jar").toFile))
        val stubs = use(new ZipFile(nested(sdk, work, "android-stubs-src.jar").toFile))
        val sources = StubNames.read(stubs)
        val android = use(new ZipFile(framework.toFile))
        val properties = new java.util.Properties
        Using.resource(android.getInputStream(android.getEntry("build.prop")))(properties.load)
        require(properties.getProperty("ro.build.version.sdk") == api.major.toString, s"$version does not target API $api")
        val jar = use(new ZipOutputStream(new java.io.BufferedOutputStream(Files.newOutputStream(pending))))
        assemble(api, official, android, sources, jar)
      }.get
      Files.move(pending, output, ATOMIC_MOVE, REPLACE_EXISTING)
      println(s"wrote $output (${Files.size(output)} bytes)")
    finally
      Using.resource(Files.list(work))(_.forEach(Files.delete))
      Files.delete(work)

object Transform:
  private def read(bytes: Array[Byte]): ClassNode =
    val node = new ClassNode(ASM9)
    new ClassReader(bytes).accept(node, 0)
    node

  private def write(node: ClassNode): Array[Byte] =
    // Raw custom attributes may refer to the original constant pool.
    val attributes = Iterator(node.attrs) ++ node.fields.asScala.map(_.attrs) ++ node.methods.asScala.map(_.attrs) ++
      Option(node.recordComponents).iterator.flatMap(_.asScala.map(_.attrs))
    attributes.filter(_ != null).flatMap(_.asScala).foreach(a => throw IllegalArgumentException(s"unknown attribute ${a.`type`}"))
    val writer = new ClassWriter(0)
    node.accept(writer)
    writer.toByteArray

  private def parameters(owner: ClassNode, method: MethodNode, sources: StubNames): Boolean =
    val types = Type.getArgumentTypes(method.desc)
    if types.isEmpty then return false
    val existing = Option(method.parameters)
    if existing.exists(_.asScala.exists(_.name != null)) then return false
    val start = method.instructions.iterator.asScala.takeWhile(_.getOpcode < 0).toSet
    val locals = Option(method.localVariables).toVector.flatMap(_.asScala).filter(v => start(v.start))
    var slot = if (method.access & ACC_STATIC) == 0 then 1 else 0
    val names = types.toVector.map: parameter =>
      val name = locals.find(_.index == slot).map(_.name)
      slot += parameter.getSize
      name
    val selected = if names.exists(_.isDefined) then names else sources.matching(owner, method)
    if !selected.exists(_.isDefined) then return false
    existing match
      case Some(parameters) =>
        require(parameters.size == selected.size, s"parameter count mismatch in ${owner.name}.${method.name}${method.desc}")
        parameters.asScala.zip(selected).foreach((p, name) => p.name = name.orNull)
      case None => method.parameters = selected.map(name => new ParameterNode(name.orNull, 0)).asJava
    true

  private def body(parent: String, method: MethodNode): Unit =
    if (method.access & (ACC_ABSTRACT | ACC_NATIVE)) != 0 then return
    method.instructions.clear()
    method.tryCatchBlocks.clear()
    method.localVariables = null
    method.visibleLocalVariableAnnotations = null
    method.invisibleLocalVariableAnnotations = null
    if method.name == "<init>" && parent != null then
      method.visitVarInsn(ALOAD, 0)
      method.visitMethodInsn(INVOKESPECIAL, parent, "<init>", "()V", false)
    method.visitTypeInsn(NEW, "java/lang/RuntimeException")
    method.visitInsn(DUP)
    method.visitLdcInsn("Stub!")
    method.visitMethodInsn(INVOKESPECIAL, "java/lang/RuntimeException", "<init>", "(Ljava/lang/String;)V", false)
    method.visitInsn(ATHROW)
    val receiver = if (method.access & ACC_STATIC) == 0 then 1 else 0
    method.visitMaxs(3, receiver + Type.getArgumentTypes(method.desc).map(_.getSize).sum)

  def official(bytes: Array[Byte], sources: StubNames): Array[Byte] =
    val node = read(bytes)
    val filled = node.methods.asScala.count(method => parameters(node, method, sources))
    if filled == 0 then bytes else write(node)

  def stub(bytes: Array[Byte], supplement: Option[Array[Byte]], sources: StubNames): Array[Byte] =
    val base = read(bytes)
    base.version = (base.version & 0xffff0000) | V1_8
    // Keep each method's source owner until its LVT and nesting information have been consumed.
    val additions = supplement.toVector.flatMap: payload =>
      val official = read(payload)
      val fields = base.fields.asScala.map(f => f.name -> f.desc).toSet
      val addedFields = official.fields.asScala.filterNot(f => fields(f.name -> f.desc))
      val retyped = addedFields.map(_.name).toSet
      base.fields.removeIf(f => retyped(f.name))
      addedFields.foreach(f => base.fields.add(new FieldNode(ASM9, f.access, f.name, f.desc, f.signature, f.value)))
      def overload(m: MethodNode) = m.name -> m.desc.takeWhile(_ != ')')
      def real(m: MethodNode) = (m.access & ACC_BRIDGE) == 0
      val methods = base.methods.asScala.map(m => m.name -> m.desc).toSet
      val added = official.methods.asScala.filterNot(m => methods(m.name -> m.desc))
      val originals = base.methods.asScala.filter(real).map(m => overload(m) -> m).toMap
      added.filter(real).flatMap(m => originals.get(overload(m))).foreach(base.methods.remove)
      val nested = base.innerClasses.asScala.map(_.name).toSet
      base.innerClasses.addAll(official.innerClasses.asScala.filterNot(n => nested(n.name)).asJava)
      added.map: original =>
        parameters(official, original, sources)
        val method = new MethodNode(ASM9, original.access, original.name, original.desc, original.signature, original.exceptions.toArray(Array.empty[String]))
        method.parameters = original.parameters
        body(base.superName, method)
        method
    base.methods.asScala.foreach: method =>
      parameters(base, method, sources)
      body(base.superName, method)
    base.methods.addAll(additions.asJava)
    write(base)

final case class Signature(name: String, parameters: Vector[String])
enum Names:
  case Unique(parameters: Vector[String])
  case Ambiguous

final class StubNames(classes: Map[String, Map[Signature, Names]]):
  private var missing, ambiguous, fromSource = 0
  def coverage = s"stub-source lookups: $fromSource filled, $missing unresolved, $ambiguous ambiguous"

  def matching(owner: ClassNode, member: MethodNode): Vector[Option[String]] =
    val parameters = Type.getArgumentTypes(member.desc).toVector.map(_.getClassName)
    val key = Signature(member.name, parameters)
    val methods = classes.getOrElse(owner.name, Map.empty)
    val hasOuter = member.name == "<init>" && owner.innerClasses.asScala.exists: entry =>
      entry.name == owner.name && entry.outerName != null && (entry.access & ACC_STATIC) == 0 &&
        parameters.headOption.contains(entry.outerName.replace('/', '.'))
    val inner = Option.when(hasOuter):
      key.copy(parameters = parameters.tail)
    (methods.get(key), inner.flatMap(methods.get)) match
      case (Some(Names.Unique(names)), None) => fromSource += 1; names.map(Some(_))
      case (None, Some(Names.Unique(names))) => fromSource += 1; None +: names.map(Some(_))
      case (None, None) => missing += 1; Vector.empty
      case _ => ambiguous += 1; Vector.empty

object StubNames:
  private final case class Bound(tree: Option[Tree], scope: mutable.Map[String, Bound])
  private final case class Declaration(tree: ClassTree, internal: String, packageName: String, bounds: mutable.Map[String, Bound])

  def read(jar: ZipFile): StubNames =
    val compiler = Option(ToolProvider.getSystemJavaCompiler).getOrElse:
      throw IllegalStateException("Stub parameter names require a JDK with javac; use JDK 21")
    val classes = mutable.Map.empty[String, String]
    val declarations = mutable.ArrayBuffer.empty[Declaration]

    def bounds(inherited: mutable.Map[String, Bound], parameters: java.util.List[? <: TypeParameterTree]): mutable.Map[String, Bound] =
      val scope = mutable.Map.from(inherited)
      parameters.asScala.foreach: parameter =>
        scope(parameter.getName.toString) = Bound(parameter.getBounds.asScala.headOption, scope)
      scope

    def collect(tree: ClassTree, packageName: String, owner: String, internalOwner: String, inherited: mutable.Map[String, Bound]): Unit =
      val name = tree.getSimpleName.toString
      val canonical = s"${if owner.isEmpty then packageName else owner}.$name".stripPrefix(".")
      val internal = if internalOwner.isEmpty then canonical.replace('.', '/') else s"$internalOwner$$$name"
      val scope = bounds(inherited, tree.getTypeParameters)
      classes(canonical) = internal.replace('/', '.')
      declarations += Declaration(tree, internal, packageName, scope)
      tree.getMembers.asScala.foreach:
        case nested: ClassTree => collect(nested, packageName, canonical, internal, scope)
        case _ => ()

    Using.Manager { use =>
      val files = use(compiler.getStandardFileManager(null, null, UTF_8))
      val sources = jar.entries.asScala.filter(_.getName.endsWith(".java")).map: entry =>
        val uri = new java.net.URI(null, null, "/" + entry.getName, null)
        new SimpleJavaFileObject(uri, JavaFileObject.Kind.SOURCE):
          override def getCharContent(ignoreEncodingErrors: Boolean): CharSequence =
            Using.resource(jar.getInputStream(entry))(input => new String(input.readAllBytes(), UTF_8))
      val diagnostics = new DiagnosticCollector[JavaFileObject]
      val task = compiler.getTask(null, files, diagnostics, List("-proc:none").asJava, null,
        sources.toVector.asJava).asInstanceOf[JavacTask]
      // Parse only: attribution needs the Android build's classpath and is deliberately absent.
      task.parse().asScala.foreach: unit =>
        val packageName = Option(unit.getPackageName).fold("")(_.toString)
        unit.getTypeDecls.asScala.foreach:
          case tree: ClassTree => collect(tree, packageName, "", "", mutable.Map.empty)
          case _ => ()
      diagnostics.getDiagnostics.asScala.find(_.getKind == Diagnostic.Kind.ERROR).foreach: diagnostic =>
        throw IllegalArgumentException(diagnostic.toString)
    }.get

    def canonical(name: String): String =
      Iterator.iterate(name.length)(end => name.lastIndexOf('.', end - 1)).takeWhile(_ > 0)
        .flatMap(end => classes.get(name.take(end)).map(_ + name.drop(end).replace('.', '$'))).nextOption().getOrElse(name)

    def qualified(tree: Tree): String = tree match
      case generic: ParameterizedTypeTree => qualified(generic.getType)
      case annotated: AnnotatedTypeTree => qualified(annotated.getUnderlyingType)
      case member: MemberSelectTree => s"${qualified(member.getExpression)}.${member.getIdentifier}"
      case _ => tree.toString

    def erased(tree: Tree, packageName: String, scope: mutable.Map[String, Bound], resolving: Set[String] = Set.empty): String = tree match
      case annotated: AnnotatedTypeTree => erased(annotated.getUnderlyingType, packageName, scope, resolving)
      case array: ArrayTypeTree => erased(array.getType, packageName, scope, resolving) + "[]"
      case generic: ParameterizedTypeTree => erased(generic.getType, packageName, scope, resolving)
      case primitive: PrimitiveTypeTree => primitive.toString
      case member: MemberSelectTree => canonical(qualified(member))
      case _ =>
        val name = tree.toString
        scope.get(name) match
          case Some(Bound(None, _)) => "java.lang.Object"
          case Some(Bound(Some(bound), inherited)) =>
            require(!resolving(name), s"cyclic type bound: $name")
            erased(bound, packageName, inherited, resolving + name)
          case None => canonical(if name.contains('.') || packageName.isEmpty then name else s"$packageName.$name")

    val signatures = declarations.toVector.flatMap: declaration =>
      declaration.tree.getMembers.asScala.collect:
        case method: MethodTree if !method.getParameters.isEmpty =>
          val scope = bounds(declaration.bounds, method.getTypeParameters)
          val parameters = method.getParameters.asScala.toVector
          val key = Signature(method.getName.toString, parameters.map(parameter => erased(parameter.getType, declaration.packageName, scope)))
          (declaration.internal, key, parameters.map(_.getName.toString))
    val index = signatures.groupMap(_._1)(entry => entry._2 -> entry._3).view.mapValues: methods =>
      methods.groupMap(_._1)(_._2).view.mapValues:
        case Vector(names) => Names.Unique(names)
        case _ => Names.Ambiguous
      .toMap
    new StubNames(index.toMap)
