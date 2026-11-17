import scala.collection.mutable

final class Pool(original: ClassFile):
  private val constants = mutable.ArrayBuffer.from(original.pool)
  private val known = mutable.Map.empty[Constant, Int]
  original.pool.zipWithIndex.foreach: (constant, index) =>
    if constant != Constant.Vacant then known.getOrElseUpdate(constant, index)

  def entries: Vector[Constant] = constants.toVector
  def intern(constant: Constant): Int = known.getOrElseUpdate(constant, {
    val index = constants.size
    require(index + constant.width <= 0xffff, "constant pool overflow")
    constants += constant
    if constant.width == 2 then constants += Constant.Vacant
    index
  })
  def utf8(value: String): Int = intern(Constant.text(value))
  def attribute(name: String)(body: => Array[Byte]): Attribute =
    val index = utf8(name)
    Attribute(index, body)
  private def method(owner: Int, name: String, descriptor: String): Int =
    intern(Constant.Method(owner, intern(Constant.NameAndType(utf8(name), utf8(descriptor)))))

  private lazy val throwing: Array[Byte] = Binary.encode: out =>
    val exception = intern(Constant.Class(utf8("java/lang/RuntimeException")))
    val message = intern(Constant.String(utf8("Stub!")))
    val init = method(exception, "<init>", "(Ljava/lang/String;)V")
    out.u1(0xbb); out.u2(exception); out.u1(0x59)
    if message > 0xff then { out.u1(0x13); out.u2(message) }
    else { out.u1(0x12); out.u1(message) }
    out.u1(0xb7); out.u2(init); out.u1(0xbf)
  private lazy val superInit: Array[Byte] = Binary.encode: out =>
    out.u1(0x2a); out.u1(0xb7); out.u2(method(original.superClass, "<init>", "()V"))

  def stubCode(owner: ClassFile, member: Member): Attribute =
    val body = throwing // Preserve constant-pool insertion order: exception before super().
    val instructions = if owner.text(member.name) == "<init>" && original.superClass != 0 then superInit ++ body else body
    val locals = Descriptor.parameters(owner.text(member.descriptor)).map(_.slots).sum + (if member.static then 0 else 1)
    attribute("Code"):
      Binary.encode: out =>
        out.u2(3); out.u2(locals); out.u4(instructions.length); out.bytes(instructions); out.u2(0); out.u2(0)

  def parameters(names: Vector[Int]): Option[Attribute] = Option.when(names.exists(_ != 0)):
    attribute("MethodParameters"):
      Binary.encode: out =>
        out.u1(names.size)
        names.foreach: name =>
          out.u2(name); out.u2(0)

object Transform:
  final case class Supplement(bytes: Array[Byte], members: Int, innerClasses: Int)

  private def names(owner: ClassFile, member: Member, pool: Pool, sources: StubNames, remap: Int => Int = identity): Option[Attribute] =
    if owner.named(member.attributes, "MethodParameters").nonEmpty then return None
    val names = owner.parameterNames(member)
    pool.parameters(if names.exists(_ != 0) then names.map(remap)
      else sources.matching(owner, member).map(_.fold(0)(pool.utf8)))

  def stub(bytes: Array[Byte], sources: StubNames): Array[Byte] =
    val original = ClassFile.read(bytes)
    val pool = new Pool(original)
    val methods = original.methods.map: member =>
      val kept = member.attributes.filterNot(attribute => original.text(attribute.name) == "Code") ++ names(original, member, pool, sources)
      member.copy(attributes = kept ++ Option.when(member.concrete)(pool.stubCode(original, member)))
    // Indy/condy serve discarded bodies. Same-width NameAndType replacements keep every index valid.
    val constants = pool.entries.map:
      case Constant.Dynamic(_, signature) => original.pool(signature)
      case Constant.InvokeDynamic(_, signature) => original.pool(signature)
      case constant => constant
    original.copy(major = 52, pool = constants, methods = methods,
      attributes = original.attributes.filterNot(attribute => original.text(attribute.name) == "BootstrapMethods")).bytes

  def supplement(target: Array[Byte], source: Array[Byte], sources: StubNames): Supplement =
    val base = ClassFile.read(target)
    val official = ClassFile.read(source)
    val fieldKeys = base.fields.map(base.key).toSet
    val addedFields = official.fields.filterNot(member => fieldKeys(official.key(member)))
    val retyped = addedFields.map(member => official.text(member.name)).toSet
    val keptFields = base.fields.filterNot(member => retyped(base.text(member.name)))
    val methodKeys = base.methods.map(base.key).toSet
    val realMethods = base.methods.filterNot(_.bridge).map(member => base.overload(member) -> member).toMap
    val addedMethods = official.methods.filterNot(member => methodKeys(official.key(member)))
    val replaced = addedMethods.filterNot(_.bridge).flatMap(member => realMethods.get(official.overload(member))).toSet
    val keptMethods = base.methods.filterNot(replaced)
    val nestedNames = base.nested.map(entry => base.className(entry.inner)).toSet
    val addedNested = official.nested.filterNot(entry => nestedNames(official.className(entry.inner)))
    val members = addedFields.size + addedMethods.size
    if members + addedNested.size == 0 then return Supplement(target, 0, 0)

    val pool = new Pool(base)
    def remap(index: Int): Int = if index == 0 then 0 else pool.intern(official.pool(index).remapped(remap))
    def carry(attribute: Attribute): Option[Attribute] =
      val name = official.text(attribute.name)
      if !Set("ConstantValue", "Signature", "Exceptions", "MethodParameters", "Deprecated", "Synthetic")(name) then return None
      val index = remap(attribute.name)
      val in = new Binary.Reader(attribute.body)
      val body = Binary.encode: out =>
        name match
          case "ConstantValue" | "Signature" => out.u2(remap(in.u2()))
          case "Exceptions" => out.counted(in.counted(in.u2()))(index => out.u2(remap(index)))
          case "MethodParameters" =>
            val count = in.u1()
            out.u1(count)
            for _ <- 0 until count do { out.u2(remap(in.u2())); out.u2(in.u2()) }
          case _ => ()
      Some(Attribute(index, body))
    def encode(member: Member, isMethod: Boolean): Member =
      val attributes = member.attributes.flatMap(carry) ++
        Option.when(isMethod && member.concrete)(pool.stubCode(official, member)) ++
        (if isMethod then names(official, member, pool, sources, remap) else None)
      member.copy(name = remap(member.name), descriptor = remap(member.descriptor), attributes = attributes)

    val fields = keptFields ++ addedFields.map(encode(_, false))
    val methods = keptMethods ++ addedMethods.map(encode(_, true))
    val attributes = if addedNested.isEmpty then base.attributes else
      // Remap entries before the attribute name, matching the append-only merge's original order.
      val entries = addedNested.map(_.remapped(remap))
      val existing = base.named(base.attributes, "InnerClasses")
      val index = existing.map(_.name).getOrElse(remap(official.named(official.attributes, "InnerClasses").get.name))
      val merged = Attribute(index, Binary.encode(out => out.counted(base.nested ++ entries)(_.write(out))))
      existing match
        case Some(attribute) => base.attributes.map(current => if current eq attribute then merged else current)
        case None => base.attributes :+ merged
    Supplement(base.copy(pool = pool.entries, fields = fields, methods = methods, attributes = attributes).bytes, members, addedNested.size)
