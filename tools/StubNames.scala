import com.sun.source.tree.*
import com.sun.source.util.JavacTask
import javax.tools.{Diagnostic, DiagnosticCollector, JavaFileObject, ToolProvider}
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.{Files, Path}
import scala.collection.mutable
import scala.jdk.CollectionConverters.*
import scala.util.Using

final case class Signature(name: String, parameters: Vector[String])
enum Names:
  case Unique(parameters: Vector[String])
  case Ambiguous

final class StubNames(classes: Map[String, Map[Signature, Names]]):
  def matching(owner: ClassFile, member: Member): Vector[Option[String]] =
    val parameters = Descriptor.parameters(owner.text(member.descriptor)).map(_.canonical)
    val key = Signature(owner.text(member.name), parameters)
    val methods = classes.getOrElse(owner.name, Map.empty)
    val inner = Option.when(key.name == "<init>" && owner.outer.exists(parameters.headOption.contains)):
      key.copy(parameters = parameters.drop(1))
    methods.get(key) match
      case Some(Names.Unique(names)) if !inner.exists(methods.contains) => names.map(Some(_))
      case Some(_) => Vector.empty
      case None => inner.flatMap(methods.get) match
        case Some(Names.Unique(names)) => None +: names.map(Some(_))
        case _ => Vector.empty

object StubNames:
  private final case class Bound(tree: Option[Tree], scope: mutable.Map[String, Bound])
  private final case class Declaration(tree: ClassTree, internal: String, packageName: String, bounds: mutable.Map[String, Bound])

  def read(directory: Path): StubNames =
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
      val paths = use(Files.walk(directory))
      val files = use(compiler.getStandardFileManager(null, null, UTF_8))
      val sources = paths.iterator.asScala.filter(_.toString.endsWith(".java")).toVector.sorted
      val diagnostics = new DiagnosticCollector[JavaFileObject]
      val task = compiler.getTask(null, files, diagnostics, List("-proc:none").asJava, null,
        files.getJavaFileObjectsFromPaths(sources.asJava)).asInstanceOf[JavacTask]
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
